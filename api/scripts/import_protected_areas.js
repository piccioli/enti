/* eslint-disable no-console */
'use strict';

/**
 * Importa aree protette da un GeoJSON (FeatureCollection) in PostGIS.
 * Popola anche municipality_protected_area tramite ST_Intersects sui confini comunali.
 *
 * Variabili:
 *   SKIP_PROTECTED_AREAS=1  — esci senza errori senza fare nulla
 *   PROTECTED_AREAS_PATH     — path file .geojson (default: primo arg dopo --file o /data/protected_areas.geojson)
 *   PA_SOURCE_NAME           — etichetta sorgente (default: "geojson-import")
 *   PA_NAME_KEYS             — chiavi proprietà nome, separate da virgola
 *   PA_CODE_KEYS             — chiavi codice esterno opzionali
 *   PA_TYPE_KEYS             — chiavi tipologia opzionali
 *
 * Uso:
 *   docker compose exec api node scripts/import_protected_areas.js --file /data/aree.geojson
 */

const fs = require('fs');
const path = require('path');
const db = require('../src/db');

function parseArgs(argv) {
  const out = { file: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--file' && argv[i + 1]) {
      out.file = argv[++i];
    }
  }
  return out;
}

function splitKeys(raw, fallbackList) {
  const s = String(raw || '').trim();
  if (s) {
    return s.split(',').map((k) => k.trim()).filter(Boolean);
  }
  return fallbackList;
}

function pickProp(props, keys) {
  if (!props || typeof props !== 'object') return '';
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(props, k)) {
      const v = props[k];
      if (v != null && String(v).trim() !== '') return String(v).trim();
    }
  }
  return '';
}

async function ensureTable(client) {
  await client.query(`
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE TABLE IF NOT EXISTS protected_areas (
      id SERIAL PRIMARY KEY,
      external_code TEXT,
      name TEXT NOT NULL,
      area_type TEXT,
      source_name TEXT,
      geom geometry(MultiPolygon, 4326) NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS protected_areas_external_code_unique
      ON protected_areas (external_code)
      WHERE external_code IS NOT NULL AND btrim(external_code) <> '';
    CREATE INDEX IF NOT EXISTS protected_areas_geom_idx ON protected_areas USING GIST (geom);
    CREATE INDEX IF NOT EXISTS protected_areas_name_trgm_idx ON protected_areas USING gin (name gin_trgm_ops);
    CREATE TABLE IF NOT EXISTS municipality_protected_area (
      pro_com INTEGER NOT NULL REFERENCES municipalities (pro_com) ON DELETE CASCADE,
      protected_area_id INTEGER NOT NULL REFERENCES protected_areas (id) ON DELETE CASCADE,
      PRIMARY KEY (pro_com, protected_area_id)
    );
    CREATE INDEX IF NOT EXISTS municipality_protected_area_area_idx
      ON municipality_protected_area (protected_area_id);
  `);
}

async function replaceAll(client, filePath, sourceName, nameKeys, codeKeys, typeKeys) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const gj = JSON.parse(raw);
  if (!gj || gj.type !== 'FeatureCollection' || !Array.isArray(gj.features)) {
    throw new Error('GeoJSON deve essere FeatureCollection');
  }

  await client.query('TRUNCATE protected_areas RESTART IDENTITY CASCADE');

  let inserted = 0;
  let skipped = 0;

  await client.query('BEGIN');
  try {
    for (const feat of gj.features) {
      if (!feat || feat.type !== 'Feature' || !feat.geometry) {
        skipped++;
        continue;
      }
      const props = feat.properties || {};
      const name = pickProp(props, nameKeys);
      if (!name) {
        skipped++;
        continue;
      }
      const externalCodeRaw = pickProp(props, codeKeys);
      const externalCode = externalCodeRaw ? externalCodeRaw : null;
      const areaType = pickProp(props, typeKeys) || null;
      const gjson = JSON.stringify(feat.geometry);

      try {
        const ins = await client.query(
          `INSERT INTO protected_areas (external_code, name, area_type, source_name, geom)
           VALUES (
             $1,
             $2,
             $3,
             $4,
             ST_Multi(
               ST_CollectionExtract(
                 ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($5::text), 4326)),
                 3
               )
             )
           )
           ON CONFLICT (external_code)
             WHERE external_code IS NOT NULL AND btrim(external_code) <> ''
           DO NOTHING`,
          [externalCode, name, areaType, sourceName, gjson]
        );
        if (ins.rowCount > 0) inserted++;
        else skipped++;
      } catch (e) {
        console.warn(`WARN: geometria saltata per "${name}": ${e.message}`);
        skipped++;
      }
    }

    await client.query(`
      INSERT INTO municipality_protected_area (pro_com, protected_area_id)
      SELECT m.pro_com, p.id
      FROM municipalities m
      INNER JOIN protected_areas p ON ST_Intersects(m.geom, p.geom)
      ON CONFLICT DO NOTHING
    `);

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }

  return { inserted, skipped, features: gj.features.length };
}

async function main() {
  if (process.env.SKIP_PROTECTED_AREAS === '1') {
    console.log('SKIP_PROTECTED_AREAS=1: import aree protette saltato.');
    process.exit(0);
  }

  const args = parseArgs(process.argv);
  const filePath =
    args.file ||
    process.env.PROTECTED_AREAS_PATH ||
    '/data/protected_areas.geojson';

  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.warn(`WARN: file aree protette assente (${resolved}); nessun dato caricato.`);
    process.exit(0);
  }

  const sourceName = process.env.PA_SOURCE_NAME || 'geojson-import';
  const nameKeys = splitKeys(process.env.PA_NAME_KEYS, [
    'nome_gazze',
    'name',
    'NOME',
    'DENOM',
    'DENOMINAZION',
    'DENOMINAZIONE',
    'nome_area',
    'AREA',
  ]);
  const codeKeys = splitKeys(process.env.PA_CODE_KEYS, [
    'codice_are',
    'code',
    'CODICE',
    'id',
    'ID',
    'COD_EUAP',
    'euap_code',
    'OBJECTID',
  ]);
  const typeKeys = splitKeys(process.env.PA_TYPE_KEYS, [
    'tipo',
    'type',
    'TIPO',
    'TIPOLOGIA',
    'CATEGORIA',
    'tipo_area',
  ]);

  const client = await db.connect();
  try {
    await ensureTable(client);
    const counts = await replaceAll(client, resolved, sourceName, nameKeys, codeKeys, typeKeys);
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM protected_areas`);
    const { rows: r2 } = await client.query(`SELECT count(*)::int AS n FROM municipality_protected_area`);
    console.log(
      `OK protected_areas: righe geometrie considerate=${counts.features}, inserimenti tentati=${counts.inserted}, saltate=${counts.skipped}, tot tabella=${rows[0].n}, join comuni=${r2[0].n}`
    );
  } finally {
    client.release();
  }

  await db.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
