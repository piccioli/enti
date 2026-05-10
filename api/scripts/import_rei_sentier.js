/* eslint-disable no-console */
'use strict';

/**
 * Importa sentieri REI da file GeoJSON precaricati (nessuna chiamata HTTP).
 * Percorso predefinito: file in $DATAPACK_DIR/sentieri e/o $DATAPACK_DIR/sentier
 * (una sola cartella va bene; molti utenti usano `sentieri`).
 *
 * Formati accettati per ogni file (.json / .geojson):
 *   - GeoJSON Feature
 *   - FeatureCollection
 *   - Wrapper API OSM2CAI { "data": Feature | FeatureCollection }
 *
 * Le proprietà possono essere come nel datapack esportato (from_loc, distance_km, …)
 * oppure come risposta OSM2CAI (from, to, distance, ref_REI, name multilingua, …).
 *
 * Uso:
 *   REI_SENTIER_DIR=/path node scripts/import_rei_sentier.js
 *
 * Variabili:
 *   DATAPACK_DIR       Directory base (default /datapack) — si leggono sentieri/ e sentier/ se REI_SENTIER_DIR omesso
 *   REI_SENTIER_DIR    Override cartella file sentieri
 *   SKIP_REI_METRICS   Se "1", salta computeMetrics dopo l'upsert
 */

const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const { computeMetrics } = require('./rei_compute_metrics');

const DATAPACK_DIR = process.env.DATAPACK_DIR || '/datapack';

/** Cartelle candidate sotto il datapack (italiano `sentieri` + compat `sentier`). */
function defaultSentierRoots(datapackDir) {
  return [path.join(datapackDir, 'sentieri'), path.join(datapackDir, 'sentier')].filter((d) =>
    fs.existsSync(d)
  );
}

function toInt(v) {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : null;
}

function toFloat(v) {
  const n = parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : null;
}

function toBool(v) {
  if (v == null || v === '') return null;
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

/** Testo o primo campo utile da oggetto multilingua / dict CAi scale string */
function normText(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v || null;
  if (typeof v === 'object') {
    const s = v.it ?? v.en ?? Object.values(v).find((x) => typeof x === 'string');
    return s ? String(s) : JSON.stringify(v);
  }
  return String(v);
}

function unwrapRoot(body) {
  if (body && body.data != null) return body.data;
  return body;
}

function extractFeatures(parsed, filename) {
  const root = unwrapRoot(parsed);
  if (!root) return [];
  if (root.type === 'Feature' && root.geometry) return [root];
  if (root.type === 'FeatureCollection' && Array.isArray(root.features)) {
    return root.features.filter((f) => f && f.type === 'Feature' && f.geometry);
  }
  throw new Error(`${filename}: atteso Feature o FeatureCollection`);
}

function resolveRouteId(p, featureIndex) {
  return (
    toInt(p.id)
    ?? toInt(p.osm2cai_id)
    ?? toInt(p.ID)
    ?? (Number.isFinite(featureIndex) ? Math.trunc(featureIndex) : null)
  );
}

function parseUpdatedAt(p) {
  const raw = p.updated_at;
  if (!raw) return new Date();
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/** @returns {Promise<boolean>} true se inserito/aggiornato; false se saltato (solo SDA fuori 3/4) */
async function upsertFromProperties(client, feat, fallbackIndex) {
  const p = feat.properties || {};
  const routeId = resolveRouteId(p, fallbackIndex);
  if (routeId == null) throw new Error('id sentiero mancante nelle properties');

  const sda = toInt(p.sda);
  if (!sda || ![3, 4].includes(sda)) return false;

  const geomJson = JSON.stringify(feat.geometry);
  /* GeoJSON da OSM2CAI ha spesso coordinate Z; la colonna è 2D */
  const geomSql = `ST_Multi(ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON($1::text), 4326)))`;
  const updatedAt = parseUpdatedAt(p);

  const fromLoc = p.from_loc ?? p.from ?? null;
  const toLoc = p.to_loc ?? p.to ?? null;
  const refRei = p.ref_rei ?? p.ref_REI ?? null;
  const distanceKm = toFloat(p.distance_km) ?? toFloat(p.distance);
  const nameVal = normText(p.name);
  const abstractVal = normText(p.abstract);
  const scaleStr = typeof p.cai_scale_string === 'object' && p.cai_scale_string !== null
    ? normText(p.cai_scale_string)
    : (p.cai_scale_string ?? null);

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
      $2, $3, $4, $5, $6, $7,
      $8, $9,
      $10, $11,
      $12, $13, $14, $15,
      $16, $17, $18, $19,
      $20, $21, $22,
      $23, $24, $25, $26,
      $27, $28,
      $29, $30, $31,
      $32, $33, $34,
      $35, $36, now(), ${geomSql}
    )
    ON CONFLICT (id) DO UPDATE SET
      relation_id = EXCLUDED.relation_id,
      ref = EXCLUDED.ref,
      ref_rei = EXCLUDED.ref_rei,
      name = EXCLUDED.name,
      sda = EXCLUDED.sda,
      cai_scale = EXCLUDED.cai_scale,
      cai_scale_string = EXCLUDED.cai_scale_string,
      from_loc = EXCLUDED.from_loc,
      to_loc = EXCLUDED.to_loc,
      city_from = EXCLUDED.city_from,
      city_from_istat = EXCLUDED.city_from_istat,
      region_from = EXCLUDED.region_from,
      region_from_istat = EXCLUDED.region_from_istat,
      city_to = EXCLUDED.city_to,
      city_to_istat = EXCLUDED.city_to_istat,
      region_to = EXCLUDED.region_to,
      region_to_istat = EXCLUDED.region_to_istat,
      distance_km = EXCLUDED.distance_km,
      ascent_m = EXCLUDED.ascent_m,
      descent_m = EXCLUDED.descent_m,
      ele_min_m = EXCLUDED.ele_min_m,
      ele_max_m = EXCLUDED.ele_max_m,
      ele_from_m = EXCLUDED.ele_from_m,
      ele_to_m = EXCLUDED.ele_to_m,
      duration_forward_min = EXCLUDED.duration_forward_min,
      duration_backward_min = EXCLUDED.duration_backward_min,
      roundtrip = EXCLUDED.roundtrip,
      abstract = EXCLUDED.abstract,
      gpx_url = EXCLUDED.gpx_url,
      validation_date = EXCLUDED.validation_date,
      survey_date = EXCLUDED.survey_date,
      osm2cai_status = EXCLUDED.osm2cai_status,
      source_url = EXCLUDED.source_url,
      updated_at = EXCLUDED.updated_at,
      fetched_at = now(),
      geom = EXCLUDED.geom`,
    [
      geomJson,
      routeId,
      toInt(p.relation_id),
      p.ref ?? null,
      refRei,
      nameVal,
      sda,
      p.cai_scale ?? null,
      scaleStr,
      fromLoc,
      toLoc,
      p.city_from ?? null,
      p.city_from_istat ?? null,
      p.region_from ?? null,
      p.region_from_istat ?? null,
      p.city_to ?? null,
      p.city_to_istat ?? null,
      p.region_to ?? null,
      p.region_to_istat ?? null,
      distanceKm,
      toInt(p.ascent_m) ?? toInt(p.ascent),
      toInt(p.descent_m) ?? toInt(p.descent),
      toInt(p.ele_min_m) ?? toInt(p.ele_min),
      toInt(p.ele_max_m) ?? toInt(p.ele_max),
      toInt(p.ele_from_m) ?? toInt(p.ele_from),
      toInt(p.ele_to_m) ?? toInt(p.ele_to),
      toInt(p.duration_forward_min) ?? toInt(p.duration_forward),
      toInt(p.duration_backward_min) ?? toInt(p.duration_backward),
      toBool(p.roundtrip),
      abstractVal,
      p.gpx_url ?? null,
      toDateStr(p.validation_date),
      toDateStr(p.survey_date),
      p.osm2cai_status != null ? String(p.osm2cai_status) : null,
      p.source_url ?? null,
      updatedAt,
    ]
  );
  return true;
}

function listSentierFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const names = fs.readdirSync(dir);
  return names
    .filter((n) => {
      const lower = n.toLowerCase();
      return lower.endsWith('.geojson') || lower.endsWith('.json');
    })
    .sort()
    .map((n) => path.join(dir, n));
}

function resolveScanRoots() {
  if (process.env.REI_SENTIER_DIR) {
    return [{ dir: process.env.REI_SENTIER_DIR, label: process.env.REI_SENTIER_DIR }];
  }
  const roots = defaultSentierRoots(DATAPACK_DIR);
  return roots.map((dir) => ({ dir, label: dir }));
}

async function main() {
  const scanRoots = resolveScanRoots();
  const files = [];
  for (const { dir } of scanRoots) {
    for (const f of listSentierFiles(dir)) {
      files.push(f);
    }
  }
  const seen = new Set();
  const uniqueFiles = files.filter((f) => {
    if (seen.has(f)) return false;
    seen.add(f);
    return true;
  });

  if (!uniqueFiles.length) {
    const hint = path.join(DATAPACK_DIR, 'sentieri');
    console.log(
      `WARN: nessun file .geojson/.json in sottocartelle sentieri/sentier di "${DATAPACK_DIR}" — import REI saltato.`
    );
    console.log(`      Esempio: precarica i GeoJSON in "${hint}".`);
    await db.end();
    process.exit(0);
  }

  const rootsLabel = scanRoots.map((r) => r.label).join(', ');
  console.log(`=== Import REI da ${uniqueFiles.length} file (${rootsLabel}) ===`);

  const client = await db.connect();
  let ok = 0;
  let skipped = 0;
  let skippedSda = 0;

  await client.query('TRUNCATE rei_hiking_routes RESTART IDENTITY CASCADE');

  let featIndex = 0;
  for (const filePath of uniqueFiles) {
    const basename = path.basename(filePath);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      console.warn(`  WARN ${basename}: JSON non valido — ${e.message}`);
      skipped++;
      continue;
    }

    let features;
    try {
      features = extractFeatures(parsed, basename);
    } catch (e) {
      console.warn(`  WARN ${basename}: ${e.message}`);
      skipped++;
      continue;
    }

    for (const feat of features) {
      featIndex++;
      try {
        const inserted = await upsertFromProperties(client, feat, featIndex);
        if (inserted) ok++;
        else skippedSda++;
      } catch (e) {
        console.warn(`  WARN ${basename} feature #${featIndex}: ${e.message}`);
        skipped++;
      }
    }
  }

  console.log(
    `  Inseriti/aggiornati: ${ok}, saltati (SDA≠3/4): ${skippedSda}, altri errori: ${skipped}`
  );

  if (process.env.SKIP_REI_METRICS !== '1') {
    await computeMetrics(client);
  }

  client.release();

  const { rows } = await db.query('SELECT count(*)::int AS n FROM rei_hiking_routes');
  console.log(`\nOK: ${rows[0].n} sentieri REI in DB.`);

  await db.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
