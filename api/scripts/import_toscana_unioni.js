/* eslint-disable no-console */
'use strict';

/**
 * Importa le Unioni di Comuni della Toscana (Regione Toscana Open Data) nel DB PostGIS.
 *
 * Fonte (CSV): "Comuni della Toscana con funzione statistica associata per statuto al 01/01/2024"
 * https://dati.toscana.it/dataset/comuni-della-toscana-con-funzione-statistica-associata-per-statuto-al-01-01-2024
 *
 * Uso (dentro docker):
 *   docker compose exec api node scripts/import_toscana_unioni.js
 *
 * Opzioni:
 *   --url <csvUrl>   override sorgente CSV
 *   --append         non cancella i membri già presenti (default: replace)
 */

const db = require('../src/db');

const DEFAULT_URL =
  'https://dati.toscana.it/dataset/c8165a9a-28ac-4eff-9510-4d7599c9be16/resource/11acaf1a-98ed-4ca5-99ce-0193457c66e0/download/comuni-toscana-con-funzione-statistica-associata-per-statuto_agg-1gen24.csv';

function parseArgs(argv) {
  const out = { url: DEFAULT_URL, append: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--append') out.append = true;
    else if (a === '--url') out.url = argv[++i];
  }
  return out;
}

function slugify(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function inferKind(unionLabel) {
  const s = String(unionLabel).toLowerCase();
  // In Toscana molte unioni sono "unione montana" / "unione montana dei comuni ..." / "unione di comuni montani ..."
  if (s.includes('montan')) return 'unioni_montane';
  return 'unioni_di_comuni';
}

function parseCsvLine(line) {
  // CSV semplice con eventuali campi tra virgolette; gestiamo il caso generico.
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

async function fetchText(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  return await res.text();
}

async function upsertGroup(client, { slug, label, kind, notes }) {
  const { rows } = await client.query(
    `INSERT INTO territorial_groups (slug, label, group_kind, notes)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (slug) DO UPDATE
       SET label = EXCLUDED.label,
           group_kind = EXCLUDED.group_kind,
           notes = EXCLUDED.notes
     RETURNING id`,
    [slug, label, kind, notes]
  );
  return rows[0].id;
}

async function replaceMembers(client, groupId, proComs) {
  await client.query('DELETE FROM territorial_group_members WHERE group_id = $1', [groupId]);
  for (const proCom of proComs) {
    await client.query(
      `INSERT INTO territorial_group_members (group_id, pro_com)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [groupId, proCom]
    );
  }
}

async function appendMembers(client, groupId, proComs) {
  for (const proCom of proComs) {
    await client.query(
      `INSERT INTO territorial_group_members (group_id, pro_com)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [groupId, proCom]
    );
  }
}

async function main() {
  const { url, append } = parseArgs(process.argv);
  console.log(`Downloading Toscana CSV: ${url}`);
  const text = await fetchText(url);

  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error('CSV vuoto o non valido');

  const header = parseCsvLine(lines[0]);
  const idxIstat = header.findIndex((h) => /^codice istat$/i.test(h));
  const idxUnion = header.findIndex((h) => /^stato associativo$/i.test(h));
  const idxComune = header.findIndex((h) => /^comuni$/i.test(h));

  if (idxIstat < 0 || idxUnion < 0 || idxComune < 0) {
    throw new Error(`Header inatteso: ${header.join(' | ')}`);
  }

  /** @type {Map<string, {label: string, members: Set<number>}>} */
  const unions = new Map();

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const unionLabel = cols[idxUnion];
    const istatRaw = cols[idxIstat];
    const comune = cols[idxComune];

    if (!unionLabel || /comune non in unione/i.test(unionLabel)) continue;

    const proCom = parseInt(String(istatRaw).replace(/^0+/, ''), 10);
    if (!Number.isFinite(proCom)) {
      console.warn(`Skip row ${i + 1}: bad ISTAT "${istatRaw}" (${comune})`);
      continue;
    }

    if (!unions.has(unionLabel)) unions.set(unionLabel, { label: unionLabel, members: new Set() });
    unions.get(unionLabel).members.add(proCom);
  }

  console.log(`Found ${unions.size} unioni (da CSV).`);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    let created = 0;
    let updated = 0;
    let totalMembers = 0;

    for (const { label, members } of unions.values()) {
      const slug = `toscana-${slugify(label)}`;
      const kind = inferKind(label);
      const notes = 'Fonte: Regione Toscana Open Data (dataset funzione statistica associata, agg. 01/01/2024).';

      const groupId = await upsertGroup(client, { slug, label, kind, notes });

      // Controllo best-effort se il gruppo esisteva già
      const { rows: existsRows } = await client.query('SELECT 1 FROM territorial_groups WHERE id = $1', [groupId]);
      if (existsRows.length) updated++;
      else created++;

      const proComs = [...members.values()].sort((a, b) => a - b);
      totalMembers += proComs.length;

      if (append) await appendMembers(client, groupId, proComs);
      else await replaceMembers(client, groupId, proComs);
    }

    await client.query('COMMIT');
    console.log(`Done. groups=${unions.size} members=${totalMembers} mode=${append ? 'append' : 'replace'}`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

