/* eslint-disable no-console */
'use strict';

/**
 * (Opzionale) Scarica i sentieri REI da OSM2CAI v2 — la build datapack usa invece file locali
 * (`import_rei_sentier.js` + cartella datapack-dist/sentier).
 *
 * Scarica i sentieri del Catasto REI (SDA 3 e 4) da OSM2CAI v2 e li upserta in PostGIS.
 * Dopo l'upsert calcola metriche spaziali pre-calcolate (km dentro comuni, parchi, gruppi).
 *
 * Uso:
 *   node scripts/import_rei_hiking_routes.js [--reset] [--region=<cai_code>]
 *
 *   --reset      Cancella il file di progresso /tmp/rei_progress.json e ricomincia da zero
 *   --region=XX  Processa solo la regione con codice CAI indicato (per debug)
 *
 * Variabili d'ambiente:
 *   REI_RATE_DELAY_MS   Millisecondi di attesa tra una chiamata e l'altra (default: 150)
 *   REI_PROGRESS_FILE   Path del file di progresso (default: /tmp/rei_progress.json)
 *   SKIP_REI_METRICS    Se "1", salta il calcolo delle metriche spaziali dopo l'upsert
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const db = require('../src/db');
const { computeMetrics } = require('./rei_compute_metrics');

// ── Costanti ──────────────────────────────────────────────────────────────────

const OSM2CAI_BASE = 'https://osm2cai.cai.it';
const RATE_DELAY_MS = parseInt(process.env.REI_RATE_DELAY_MS || '150', 10);
const PROGRESS_FILE = process.env.REI_PROGRESS_FILE || '/tmp/rei_progress.json';

// Codici regione CAI (lettera ufficiale CAI) → cod_reg ISTAT + label.
// Riferimento: tabella codici sezione CAI / OSM2CAI. Se un codice restituisce 404, skip con warning.
const CAI_REGIONS = [
  { cai: 'P', istat: '13', label: 'Abruzzo' },
  { cai: 'T', istat: '17', label: 'Basilicata' },
  { cai: 'U', istat: '18', label: 'Calabria' },
  { cai: 'S', istat: '15', label: 'Campania' },
  { cai: 'H', istat: '08', label: 'Emilia-Romagna' },
  { cai: 'A', istat: '06', label: 'Friuli Venezia Giulia' },
  { cai: 'O', istat: '12', label: 'Lazio' },
  { cai: 'G', istat: '07', label: 'Liguria' },
  { cai: 'D', istat: '03', label: 'Lombardia' },
  { cai: 'M', istat: '11', label: 'Marche' },
  { cai: 'Q', istat: '14', label: 'Molise' },
  { cai: 'E', istat: '01', label: 'Piemonte' },
  { cai: 'R', istat: '16', label: 'Puglia' },
  { cai: 'Z', istat: '20', label: 'Sardegna' },
  { cai: 'V', istat: '19', label: 'Sicilia' },
  { cai: 'L', istat: '09', label: 'Toscana' },
  { cai: 'C', istat: '04', label: 'Trentino-Alto Adige' },
  { cai: 'N', istat: '10', label: 'Umbria' },
  { cai: 'F', istat: '02', label: 'Valle d\'Aosta' },
  { cai: 'B', istat: '05', label: 'Veneto' },
];

// ── Argomenti CLI ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { reset: false, region: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--reset') out.reset = true;
    else if (argv[i].startsWith('--region=')) out.region = argv[i].slice('--region='.length).trim();
  }
  return out;
}

// ── Progresso / resume ────────────────────────────────────────────────────────

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    }
  } catch {
    // file corrotto o assente
  }
  return { regionsDone: [], idsDone: [] };
}

function saveProgress(progress) {
  try {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress), 'utf8');
  } catch (e) {
    console.warn(`WARN: impossibile salvare progresso in ${PROGRESS_FILE}: ${e.message}`);
  }
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function fetchJson(url, attempt = 0) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      if (res.statusCode === 404) {
        const err = new Error(`HTTP 404: ${url}`);
        err.statusCode = 404;
        return reject(err);
      }
      if (res.statusCode === 429 || (res.statusCode >= 500 && res.statusCode < 600)) {
        res.resume();
        const err = new Error(`HTTP ${res.statusCode}: ${url}`);
        err.statusCode = res.statusCode;
        return reject(err);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}: ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message} — ${url}`)); }
      });
    });
    req.on('error', reject);
  });
}

async function fetchWithRetry(url, maxAttempts = 5) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fetchJson(url, attempt);
    } catch (e) {
      if (e.statusCode === 404) throw e; // non ritentare i 404
      if (attempt < maxAttempts - 1) {
        const wait = Math.pow(2, attempt) * 1000;
        console.warn(`    RETRY ${attempt + 1}/${maxAttempts - 1} (${e.message}) — attendo ${wait / 1000}s...`);
        await new Promise((r) => setTimeout(r, wait));
      } else {
        throw e;
      }
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Upsert sentiero ───────────────────────────────────────────────────────────

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

/** La risposta può essere il Feature GeoJSON diretto o annidato in `{ data: Feature }`. */
function unwrapFeature(body) {
  if (body && body.type === 'Feature') return body;
  if (body && body.data && body.data.type === 'Feature') return body.data;
  return body;
}

function resolveRouteId(properties, indexId) {
  const p = properties || {};
  return (
    toInt(p.id)
    ?? toInt(p.osm2cai_id)
    ?? toInt(p.ID)
    ?? (Number.isFinite(indexId) ? Math.trunc(indexId) : null)
  );
}

async function upsertRoute(client, feature, updatedAt, indexId) {
  const p = feature.properties || {};
  const routeId = resolveRouteId(p, indexId);
  if (routeId == null) {
    throw new Error('id sentiero mancante (properties e indice)');
  }
  const geomJson = JSON.stringify(feature.geometry);

  // Forza MultiLineString (API può restituire anche LineString singola)
  const geomSql = `ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($1::text), 4326))`;

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
      p.ref_REI ?? null,
      p.name ?? null,
      toInt(p.sda),
      p.cai_scale ?? null,
      p.cai_scale_string ?? null,
      p.from ?? null,
      p.to ?? null,
      p.city_from ?? null,
      p.city_from_istat ?? null,
      p.region_from ?? null,
      p.region_from_istat ?? null,
      p.city_to ?? null,
      p.city_to_istat ?? null,
      p.region_to ?? null,
      p.region_to_istat ?? null,
      toFloat(p.distance),
      toInt(p.ascent),
      toInt(p.descent),
      toInt(p.ele_min),
      toInt(p.ele_max),
      toInt(p.ele_from),
      toInt(p.ele_to),
      toInt(p.duration_forward),
      toInt(p.duration_backward),
      toBool(p.roundtrip),
      p.abstract ?? null,
      p.gpx_url ?? null,
      toDateStr(p.validation_date),
      toDateStr(p.survey_date),
      p.osm2cai_status ?? null,
      `${OSM2CAI_BASE}/api/v2/hiking-route/${routeId}`,
      updatedAt,
    ]
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  if (args.reset) {
    try { fs.unlinkSync(PROGRESS_FILE); } catch { /* già assente */ }
    console.log(`Progresso azzerato (${PROGRESS_FILE} rimosso).`);
  }

  const progress = loadProgress();
  let regionsToProcess = CAI_REGIONS;

  if (args.region) {
    regionsToProcess = CAI_REGIONS.filter((r) => r.cai === args.region);
    if (!regionsToProcess.length) {
      console.error(`ERROR: codice regione CAI '${args.region}' non trovato. Validi: ${CAI_REGIONS.map((r) => r.cai).join(', ')}`);
      process.exit(1);
    }
  }

  // Raccoglie tutti gli ID da scaricare per ogni regione
  const allIds = new Map(); // id → updatedAt
  const failedRegions = [];

  for (let i = 0; i < regionsToProcess.length; i++) {
    const region = regionsToProcess[i];
    const prefix = `[${i + 1}/${regionsToProcess.length}] ${region.label} (${region.cai})`;

    if (!args.region && progress.regionsDone.includes(region.cai)) {
      console.log(`${prefix}: già completata (resume), skip.`);
      continue;
    }

    process.stdout.write(`${prefix}: indice sentieri...`);
    try {
      const index = await fetchWithRetry(
        `${OSM2CAI_BASE}/api/v2/hiking-routes/region/${region.cai}/3,4`
      );

      const ids = Object.entries(index);
      process.stdout.write(` ${ids.length} sentieri trovati.\n`);

      for (const [id, updatedAt] of ids) {
        allIds.set(parseInt(id, 10), updatedAt);
      }
    } catch (e) {
      if (e.statusCode === 404) {
        console.log(`\n  WARN: regione '${region.cai}' restituisce 404 (codice non riconosciuto dall'API).`);
        failedRegions.push(region.cai);
      } else {
        console.error(`\n  ERROR: ${e.message}`);
        failedRegions.push(region.cai);
      }
    }

    await sleep(RATE_DELAY_MS);
  }

  if (failedRegions.length) {
    console.log(`\nWARN: ${failedRegions.length} regione/i non scaricate: ${failedRegions.join(', ')}`);
    console.log('     Verificare i codici in CAI_REGIONS dentro import_rei_hiking_routes.js.');
  }

  const idsToFetch = [...allIds.entries()].filter(([id]) => !progress.idsDone.includes(id));
  const total = idsToFetch.length;
  const alreadyDone = allIds.size - total;

  console.log(`\n=== Download sentieri: ${total} da scaricare (${alreadyDone} già in cache) ===`);

  const client = await db.connect();
  let downloaded = 0;
  let errors = 0;

  try {
    for (const [id, updatedAt] of idsToFetch) {
      downloaded++;
      process.stdout.write(`  [${downloaded}/${total}] id=${id} ...`);

      try {
        const raw = await fetchWithRetry(
          `${OSM2CAI_BASE}/api/v2/hiking-route/${id}`
        );
        const feat = unwrapFeature(raw);
        if (!feat || feat.type !== 'Feature' || !feat.geometry) {
          throw new Error('risposta API: GeoJSON Feature non valido');
        }

        const p = feat.properties || {};
        const ref = p.ref || '';
        const refRei = p.ref_REI || '';
        const sda = p.sda ?? '?';
        await upsertRoute(client, feat, updatedAt, id);

        progress.idsDone.push(id);
        if (downloaded % 50 === 0) saveProgress(progress);

        process.stdout.write(` ref=${ref || '—'} REI=${refRei || '—'} SDA=${sda} ✓\n`);
      } catch (e) {
        errors++;
        process.stdout.write(` ERRORE: ${e.message}\n`);
      }

      await sleep(RATE_DELAY_MS);
    }
  } finally {
    saveProgress(progress);
  }

  console.log(`\nDownload completato: ${downloaded - errors} OK, ${errors} errori.`);

  // Marca le regioni processate in questa sessione
  for (const region of regionsToProcess) {
    if (!failedRegions.includes(region.cai) && !progress.regionsDone.includes(region.cai)) {
      progress.regionsDone.push(region.cai);
    }
  }
  saveProgress(progress);

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
