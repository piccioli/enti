/* eslint-disable no-console */
'use strict';

/**
 * Importa sentieri REI e metriche spaziali da file del datapack già esportati.
 * Usato da scripts/datapack_import.sh dopo l'import dei dati base.
 *
 * Legge:
 *   /datapack/rei_hiking_routes.geojson    (FeatureCollection)
 *   /datapack/municipality_rei_stats.json  (map pro_com→{km_sda3,km_sda4})
 *   /datapack/protected_area_rei_stats.json
 *   /datapack/territorial_group_rei_stats.json
 *
 * Variabile:
 *   DATAPACK_DIR  directory contenente i file (default: /datapack)
 */

const fs = require('fs');
const path = require('path');
const db = require('../src/db');

const DATAPACK_DIR = process.env.DATAPACK_DIR || '/datapack';

function toInt(v) {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : null;
}

function toFloat(v) {
  const n = parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : null;
}

function toBool(v) {
  if (v == null) return null;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return null;
}

function toDateStr(v) {
  if (!v) return null;
  const s = String(v).trim();
  return s || null;
}

async function importRoutes(client, filePath) {
  console.log(`Importazione sentieri da ${filePath} ...`);
  const raw = fs.readFileSync(filePath, 'utf8');
  const gj = JSON.parse(raw);

  if (!gj || gj.type !== 'FeatureCollection' || !Array.isArray(gj.features)) {
    throw new Error('rei_hiking_routes.geojson deve essere FeatureCollection');
  }

  await client.query('TRUNCATE rei_hiking_routes RESTART IDENTITY CASCADE');

  let inserted = 0;
  let skipped = 0;

  for (const feat of gj.features) {
    if (!feat || feat.type !== 'Feature' || !feat.geometry) { skipped++; continue; }
    const p = feat.properties || {};
    const id = toInt(p.id);
    const sda = toInt(p.sda);
    if (!id || !sda || ![3, 4].includes(sda)) { skipped++; continue; }

    const geomJson = JSON.stringify(feat.geometry);
    try {
      await client.query(
        `INSERT INTO rei_hiking_routes (
          id, relation_id, ref, ref_rei, name, sda,
          cai_scale, cai_scale_string,
          from_loc, to_loc,
          city_from, city_from_istat, region_from, region_from_istat,
          city_to, city_to_istat, region_to, region_to_istat,
          distance_km, ascent_m, descent_m,
          ele_min_m, ele_max_m, ele_from_m, ele_to_m,
          duration_forward_min, duration_backward_min,
          roundtrip, abstract, gpx_url,
          validation_date, survey_date, osm2cai_status,
          source_url, updated_at, fetched_at, geom
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10,
          $11, $12, $13, $14,
          $15, $16, $17, $18,
          $19, $20, $21, $22, $23, $24, $25,
          $26, $27, $28, $29, $30,
          $31, $32, $33, $34, $35, $36,
          ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($37::text), 4326))
        ) ON CONFLICT (id) DO NOTHING`,
        [
          id, toInt(p.relation_id), p.ref ?? null, p.ref_rei ?? null, p.name ?? null, sda,
          p.cai_scale ?? null, p.cai_scale_string ?? null, p.from_loc ?? null, p.to_loc ?? null,
          p.city_from ?? null, p.city_from_istat ?? null, p.region_from ?? null, p.region_from_istat ?? null,
          p.city_to ?? null, p.city_to_istat ?? null, p.region_to ?? null, p.region_to_istat ?? null,
          toFloat(p.distance_km), toInt(p.ascent_m), toInt(p.descent_m),
          toInt(p.ele_min_m), toInt(p.ele_max_m), toInt(p.ele_from_m), toInt(p.ele_to_m),
          toInt(p.duration_forward_min), toInt(p.duration_backward_min),
          toBool(p.roundtrip), p.abstract ?? null, p.gpx_url ?? null,
          toDateStr(p.validation_date), toDateStr(p.survey_date),
          p.osm2cai_status ?? null, p.source_url ?? null,
          p.updated_at ?? null, p.fetched_at ?? null,
          geomJson,
        ]
      );
      inserted++;
    } catch (e) {
      console.warn(`  WARN: sentiero id=${id} saltato: ${e.message}`);
      skipped++;
    }
  }

  console.log(`  Sentieri: features=${gj.features.length}, inseriti=${inserted}, saltati=${skipped}`);
}

async function importStatsJson(client, filePath, tableName, pkCol) {
  if (!fs.existsSync(filePath)) {
    console.log(`  ${path.basename(filePath)}: assente, skip.`);
    return;
  }
  console.log(`  Import ${path.basename(filePath)} → ${tableName} ...`);
  const raw = fs.readFileSync(filePath, 'utf8');
  const map = JSON.parse(raw);

  await client.query(`TRUNCATE ${tableName}`);

  let inserted = 0;
  // Formato: { "<pk>": { "km_sda3": X, "km_sda4": Y }, ... }
  for (const [key, vals] of Object.entries(map)) {
    const pkVal = parseInt(key, 10);
    if (!Number.isFinite(pkVal)) continue;
    const pairs = [
      { sda: 3, km: parseFloat(vals.km_sda3 ?? 0) },
      { sda: 4, km: parseFloat(vals.km_sda4 ?? 0) },
    ];
    for (const { sda, km } of pairs) {
      if (!Number.isFinite(km) || km <= 0) continue;
      try {
        await client.query(
          `INSERT INTO ${tableName} (${pkCol}, sda, km_inside) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [pkVal, sda, km]
        );
        inserted++;
      } catch (e) {
        console.warn(`  WARN: ${tableName} ${pkCol}=${pkVal} sda=${sda}: ${e.message}`);
      }
    }
  }
  console.log(`  ${tableName}: ${inserted} righe inserite.`);
}

async function main() {
  const routesFile = path.join(DATAPACK_DIR, 'rei_hiking_routes.geojson');
  if (!fs.existsSync(routesFile)) {
    console.log(`WARN: ${routesFile} non trovato — sentieri REI non disponibili nel datapack.`);
    process.exit(0);
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await importRoutes(client, routesFile);

    await importStatsJson(
      client,
      path.join(DATAPACK_DIR, 'municipality_rei_stats.json'),
      'municipality_rei_stats', 'pro_com'
    );
    await importStatsJson(
      client,
      path.join(DATAPACK_DIR, 'protected_area_rei_stats.json'),
      'protected_area_rei_stats', 'protected_area_id'
    );
    await importStatsJson(
      client,
      path.join(DATAPACK_DIR, 'territorial_group_rei_stats.json'),
      'territorial_group_rei_stats', 'group_id'
    );

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  const { rows } = await db.query('SELECT count(*)::int AS n FROM rei_hiking_routes');
  console.log(`OK: ${rows[0].n} sentieri REI importati dal datapack.`);
  await db.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
