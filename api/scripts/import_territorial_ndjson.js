/* eslint-disable no-console */
'use strict';

/**
 * Import territoriale nazionale pilota da file NDJSON (una Feature JSON per riga) o JSON array.
 *
 * Oggetti attesi per riga / elemento array:
 *   slug (string obbl.)
 *   label (string obbl.)
 *   group_kind (enum tabella territorial_groups — obbl.)
 *   members (array numeri pro_com ISTAT, obbl., può essere vuoto [])
 *   notes?, valid_from? (YYYY-MM-DD), valid_to?,
 *   source_name?, source_url?, reference_year? (number), external_id?, is_demo? (boolean)
 *
 * Collisioni slug/external_id sulla coppia (source_name, external_id): fallisce con errore Postgres.
 *
 * Uso:
 *   docker compose exec api node scripts/import_territorial_ndjson.js --file /data/import.ndjson
 *   docker compose exec api node scripts/import_territorial_ndjson.js --file /data/import.ndjson --append
 */

const fs = require('fs').promises;
const readline = require('readline');
const { createReadStream } = require('fs');
const db = require('../src/db');

const VALID_KINDS = new Set([
  'unioni_di_comuni',
  'unioni_montane',
  'comunita_montane',
  'consorzi',
  'citta_metropolitane',
  'parchi_e_riserve',
  'gal_leader',
  'aree_interne',
  'altro',
]);

function parseArgs(argv) {
  let file = '';
  let append = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--file') file = argv[++i];
    else if (argv[i] === '--append') append = true;
  }
  return { file, append };
}

function validateRecord(o, idx) {
  if (!o || typeof o !== 'object') throw new Error(`${idx}: record non è un oggetto`);
  if (!String(o.slug || '').trim()) throw new Error(`${idx}: slug mancante`);
  if (!String(o.label || '').trim()) throw new Error(`${idx}: label mancante`);
  const k = String(o.group_kind || '').trim();
  if (!VALID_KINDS.has(k)) throw new Error(`${idx}: group_kind invalido "${k}"`);
  if (!Array.isArray(o.members)) throw new Error(`${idx}: members deve essere array di pro_com`);

  /** @type {number[]} */
  const members = [];
  for (let j = 0; j < o.members.length; j++) {
    const n = typeof o.members[j] === 'string' ? parseInt(o.members[j], 10) : o.members[j];
    if (!Number.isFinite(n)) throw new Error(`${idx}: member[${j}] non è un intero`);
    members.push(Number(n));
  }

  const refY = o.reference_year;
  let referenceYear = null;
  if (refY !== undefined && refY !== null && refY !== '') {
    referenceYear = parseInt(String(refY), 10);
    if (!Number.isFinite(referenceYear) || referenceYear < 1800 || referenceYear > 2200) {
      throw new Error(`${idx}: reference_year invalido`);
    }
  }

  return {
    slug: String(o.slug).trim(),
    label: String(o.label).trim(),
    group_kind: k,
    members,
    notes: o.notes != null ? String(o.notes) : null,
    valid_from: o.valid_from ? String(o.valid_from).trim().slice(0, 40) || null : null,
    valid_to: o.valid_to ? String(o.valid_to).trim().slice(0, 40) || null : null,
    source_name: o.source_name != null ? String(o.source_name).trim() || null : null,
    source_url: o.source_url != null ? String(o.source_url).trim() || null : null,
    reference_year: referenceYear,
    external_id: o.external_id != null ? String(o.external_id).trim().slice(0, 512) || null : null,
    is_demo: Boolean(o.is_demo),
  };
}

async function upsertGroup(client, r) {
  const { rows } = await client.query(
    `INSERT INTO territorial_groups (
       slug, label, group_kind, notes, valid_from, valid_to,
       source_name, source_url, reference_year, external_id, is_demo
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (slug) DO UPDATE SET
       label = EXCLUDED.label,
       group_kind = EXCLUDED.group_kind,
       notes = EXCLUDED.notes,
       valid_from = COALESCE(EXCLUDED.valid_from, territorial_groups.valid_from),
       valid_to = COALESCE(EXCLUDED.valid_to, territorial_groups.valid_to),
       source_name = COALESCE(EXCLUDED.source_name, territorial_groups.source_name),
       source_url = COALESCE(EXCLUDED.source_url, territorial_groups.source_url),
       reference_year = COALESCE(EXCLUDED.reference_year, territorial_groups.reference_year),
       external_id = COALESCE(EXCLUDED.external_id, territorial_groups.external_id),
       is_demo = EXCLUDED.is_demo
     RETURNING id`,
    [
      r.slug,
      r.label,
      r.group_kind,
      r.notes,
      r.valid_from,
      r.valid_to,
      r.source_name,
      r.source_url,
      r.reference_year,
      r.external_id,
      r.is_demo,
    ]
  );
  return rows[0].id;
}

async function replaceMembers(client, groupId, proComs) {
  await client.query('DELETE FROM territorial_group_members WHERE group_id = $1', [groupId]);
  if (!proComs.length) return;
  /** @type {unknown[]} */
  const vals = [groupId];
  /** @type {string[]} */
  const parts = [];
  proComs.forEach((pc, i) => {
    parts.push(`($1, $${i + 2})`);
    vals.push(pc);
  });
  await client.query(
    `INSERT INTO territorial_group_members (group_id, pro_com)
     VALUES ${parts.join(', ')}
     ON CONFLICT DO NOTHING`,
    vals
  );
}

async function appendMembers(client, groupId, proComs) {
  for (const pc of proComs) {
    await client.query(
      `INSERT INTO territorial_group_members (group_id, pro_com) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [groupId, pc]
    );
  }
}

async function loadRecords(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  const t = raw.trim();
  /** @type {unknown[]} */
  let arr = [];

  if (t.startsWith('[')) {
    arr = JSON.parse(t);
    if (!Array.isArray(arr)) throw new Error('Radice JSON non è un array');
  } else {
    const rl = readline.createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
    let lineIdx = 0;
    const linesArr = [];
    for await (const line of rl) {
      lineIdx++;
      const s = line.trim();
      if (!s) continue;
      try {
        linesArr.push(JSON.parse(s));
      } catch (_) {
        throw new Error(`Riga NDJSON ${lineIdx}: JSON non valido`);
      }
    }
    arr = linesArr;
  }

  /** @type {ReturnType<typeof validateRecord>[] } */
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const label = `#${i + 1}`;
    out.push(validateRecord(arr[i], label));
  }
  return out;
}

async function main() {
  const { file, append } = parseArgs(process.argv);
  if (!file) {
    console.error(
      `Uso:\n node scripts/import_territorial_ndjson.js --file /percorso/file.ndjson [--append]`
    );
    process.exitCode = 1;
    return;
  }

  const records = await loadRecords(file);
  console.log(`Letti ${records.length} raggruppamenti da ${file}`);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (let idx = 0; idx < records.length; idx++) {
      const r = records[idx];
      const gid = await upsertGroup(client, r);

      /** @type {number[]} */
      const unique = [...new Set(r.members)].sort((a, b) => a - b);
      if (append) await appendMembers(client, gid, unique);
      else await replaceMembers(client, gid, unique);

      console.log(`${idx + 1}/${records.length}\t ${r.slug}\t (${unique.length} comuni)`);
    }
    await client.query('COMMIT');
    console.log('Fatto.');
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
