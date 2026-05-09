/* eslint-disable no-console */
'use strict';

/**
 * Importa "Unioni di Comuni / Unioni Montane / Comunità montane" da un dump testuale
 * ottenuto da pdftotext dell'elenco ANCI (PDF).
 *
 * Input atteso: file .txt che contiene righe tipo:
 *   "1 Unione ... <REGIONE> <PROVINCIA> Comune1,Comune2,... <popolazione> <n_comuni>"
 *
 * Strategia parsing:
 * - identifica REGIONE e PROVINCIA cercando match su denominazioni presenti nel DB
 * - estrae lista comuni (separata da virgole) e risolve i pro_com nel DB usando la provincia
 *
 * Uso (dentro docker):
 *   node scripts/import_italy_unioni_anci_2023.js --file /data/anci-unioni-2023.txt
 *
 * Opzioni:
 *   --append   non cancella i membri già presenti (default: replace)
 */

const fs = require('fs').promises;
const db = require('../src/db');

const SOURCE_NAME = 'anci-elenco-unioni-2023';
const SOURCE_URL = 'https://www.anci.it/wp-content/uploads/Elenco-Unioni-di-Comuni-anno-2023.pdf';
const REFERENCE_YEAR = 2023;

function parseArgs(argv) {
  const out = { file: '', append: false, format: 'auto' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--append') out.append = true;
    else if (a === '--file') out.file = argv[++i];
    else if (a === '--format') out.format = String(argv[++i] || '').trim() || 'auto';
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

function normKey(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function inferKind(label) {
  const s = String(label).toLowerCase();
  if (s.includes('comunit') && s.includes('montan')) return 'comunita_montane';
  if (s.includes('unione') && s.includes('montan')) return 'unioni_montane';
  if (s.includes('montan') && s.includes('unione')) return 'unioni_montane';
  return 'unioni_di_comuni';
}

function parseAnciPdftotext(raw, regionNames, provinceNames) {
  // Formato tipico di pdftotext (senza -layout) per questo PDF:
  // indice su riga singola, poi denominazione, poi regione, poi provincia, poi blocco "COMUNI" con virgole.
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const regionSet = new Set(regionNames.map((x) => String(x).trim()));
  const provinceSet = new Set(provinceNames.map((x) => String(x).trim()));

  const isHeader = (s) =>
    /^denominazione\b/i.test(s) ||
    /^regione\b/i.test(s) ||
    /^prov\.\b/i.test(s) ||
    /^comuni\b/i.test(s) ||
    /^tot\./i.test(s) ||
    /\btotale\b/i.test(s);

  /** @type {{label: string, region: string, prov: string, comuniBlob: string}[]} */
  const out = [];

  let i = 0;
  while (i < lines.length) {
    const s = lines[i];
    if (!/^\d+$/.test(s)) {
      i++;
      continue;
    }

    // start record
    i++;
    const denomParts = [];
    while (i < lines.length && !regionSet.has(lines[i]) && !/^\d+$/.test(lines[i])) {
      if (!isHeader(lines[i])) denomParts.push(lines[i]);
      i++;
    }
    const label = denomParts.join(' ').replace(/\s+/g, ' ').trim();

    const region = i < lines.length && regionSet.has(lines[i]) ? lines[i++] : '';
    const prov = i < lines.length && provinceSet.has(lines[i]) ? lines[i++] : '';

    // avanzare fino alla prima riga con virgole (lista comuni)
    while (i < lines.length && !/^\d+$/.test(lines[i]) && !lines[i].includes(',')) i++;

    const comuniLines = [];
    while (i < lines.length && !/^\d+$/.test(lines[i])) {
      if (isHeader(lines[i])) break;
      if (lines[i].includes(',') || comuniLines.length) comuniLines.push(lines[i]);
      i++;
    }
    const comuniBlob = comuniLines.join(' ').replace(/\s+/g, ' ').trim();

    if (label && region && prov && comuniBlob) out.push({ label, region, prov, comuniBlob });
  }

  return out;
}

function findEarliestMatch(haystack, candidates) {
  const h = String(haystack);
  let best = null; // {idx, len, value}
  for (const c of candidates) {
    const idx = h.indexOf(c);
    if (idx < 0) continue;
    const len = c.length;
    if (!best || idx < best.idx || (idx === best.idx && len > best.len)) best = { idx, len, value: c };
  }
  return best ? best.value : null;
}

function parseLayoutRecordLines(raw) {
  // Formato "layout": molte righe iniziano con "<n> <denominazione> <REGIONE> <PROVINCIA> ..."
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  /** @type {string[]} */
  const out = [];
  let buf = '';
  /** @type {string[]} */
  let pendingTitle = [];

  const isJunk = (s) =>
    /^denominazione\b/i.test(s) ||
    /^regione\b/i.test(s) ||
    /^prov\.\b/i.test(s) ||
    /^comuni\b/i.test(s) ||
    /^tot\./i.test(s) ||
    /\btotale\b/i.test(s);

  for (let idx = 0; idx < lines.length; idx++) {
    const l = lines[idx];
    if (isJunk(l)) continue;
    if (/^\d+\s+\S+/.test(l)) {
      if (buf) out.push(buf.replace(/\s+/g, ' ').trim());
      const prefix = pendingTitle.length ? pendingTitle.join(' ').replace(/\s+/g, ' ').trim() : '';
      pendingTitle = [];
      // Inserisce eventuale prefisso *subito dopo* l'indice numerico, così il parsing successivo
      // trova correttamente "label ... <REGIONE> <PROVINCIA> ..."
      buf = prefix ? l.replace(/^(\d+\s+)/, `$1${prefix} `) : l;
      continue;
    }
    const next = idx + 1 < lines.length ? lines[idx + 1] : '';
    const looksLikeTitleOnly =
      /(unione|comunit)/i.test(l) && !l.includes(',') && /^\d+\s+\S+/.test(next);

    // Caso tipico del PDF: una riga "solo titolo" precede l'indice numerico del record successivo.
    // Non deve essere appesa al record precedente (altrimenti il record successivo resta senza label).
    if (looksLikeTitleOnly) {
      pendingTitle.push(l);
      if (pendingTitle.length > 3) pendingTitle = pendingTitle.slice(-3);
      continue;
    }

    if (buf) buf = `${buf} ${l}`;
    else {
      pendingTitle.push(l);
      if (pendingTitle.length > 3) pendingTitle = pendingTitle.slice(-3);
    }
  }
  if (buf) out.push(buf.replace(/\s+/g, ' ').trim());
  return out;
}

async function upsertGroup(
  client,
  { slug, label, kind, notes, source_name, source_url, reference_year, external_id }
) {
  const { rows } = await client.query(
    `INSERT INTO territorial_groups (
       slug, label, group_kind, notes,
       source_name, source_url, reference_year, external_id, is_demo
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false)
     ON CONFLICT (slug) DO UPDATE
       SET label = EXCLUDED.label,
           group_kind = EXCLUDED.group_kind,
           notes = EXCLUDED.notes,
           source_name = EXCLUDED.source_name,
           source_url = EXCLUDED.source_url,
           reference_year = EXCLUDED.reference_year,
           external_id = COALESCE(EXCLUDED.external_id, territorial_groups.external_id)
     RETURNING id`,
    [slug, label, kind, notes, source_name, source_url, reference_year, external_id]
  );
  return rows[0].id;
}

async function replaceMembers(client, groupId, proComs) {
  await client.query('DELETE FROM territorial_group_members WHERE group_id = $1', [groupId]);
  if (!proComs.length) return;
  const vals = [groupId];
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
      `INSERT INTO territorial_group_members (group_id, pro_com)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [groupId, pc]
    );
  }
}

async function main() {
  const { file, append, format } = parseArgs(process.argv);
  if (!file) {
    console.error('Uso: node scripts/import_italy_unioni_anci_2023.js --file /path/file.txt [--append]');
    process.exitCode = 1;
    return;
  }

  const client = await db.connect();
  try {
    // lista regioni/province dal DB per parsing deterministico
    const { rows: regRows } = await client.query(`SELECT den_reg FROM regions ORDER BY LENGTH(den_reg) DESC`);
    const { rows: provRows } = await client.query(
      `SELECT cod_prov::int AS cod_prov, den_prov FROM provinces ORDER BY LENGTH(den_prov) DESC`
    );

    const regionNames = regRows.map((r) => String(r.den_reg).trim());
    const provinceNames = provRows.map((r) => String(r.den_prov).trim());
    const provinceByName = new Map(provRows.map((r) => [String(r.den_prov).trim(), Number(r.cod_prov)]));

    const raw = await fs.readFile(file, 'utf8');
    const hasLayoutStyle = /^\d+\s+\S+/m.test(raw);
    const forceColumns = format === 'columns' || format === 'col' || format === 'table';
    const forceLayout = format === 'layout';
    const useLayout = forceLayout || (!forceColumns && hasLayoutStyle);

    const layoutLines = useLayout ? parseLayoutRecordLines(raw) : [];
    const records = useLayout ? [] : parseAnciPdftotext(raw, regionNames, provinceNames);
    console.log(
      useLayout
        ? `Letti ${layoutLines.length} record grezzi (layout) da ${file}`
        : `Letti ${records.length} record grezzi (colonne) da ${file}`
    );

    /** cache cod_prov -> Map(normComune -> pro_com) */
    const muniByProv = new Map();

    async function getMuniMapForProv(codProv) {
      if (muniByProv.has(codProv)) return muniByProv.get(codProv);
      const { rows } = await client.query(
        `SELECT pro_com::int AS pro_com, comune
         FROM municipalities
         WHERE cod_prov = $1
         ORDER BY pro_com`,
        [codProv]
      );
      const m = new Map();
      for (const r of rows) {
        const k = normKey(r.den_com || r.comune);
        if (!k) continue;
        // se c'è collisione, teniamo il primo e segnaliamo
        if (m.has(k) && m.get(k) !== r.pro_com) {
          // collisioni nello stesso cod_prov dovrebbero essere rare; log solo una volta
          // (non alziamo errore per non bloccare la build)
          // eslint-disable-next-line no-console
          console.warn(`WARN: collisione nome comune in prov ${codProv}: "${r.den_com || r.comune}"`);
        } else {
          m.set(k, Number(r.pro_com));
        }
      }
      muniByProv.set(codProv, m);
      return m;
    }

    await client.query('BEGIN');

    if (!append) {
      // Modalità "replace": rimuove tutte le righe della stessa fonte,
      // così non restano in DB gruppi vecchi (es. label vuote da parsing precedente).
      await client.query(
        `DELETE FROM territorial_group_members m
         USING territorial_groups g
         WHERE m.group_id = g.id AND g.source_name = $1`,
        [SOURCE_NAME]
      );
      await client.query(`DELETE FROM territorial_groups WHERE source_name = $1`, [SOURCE_NAME]);
    }

    let okGroups = 0;
    let okMembers = 0;
    let skippedGroups = 0;

    for (const r of useLayout ? layoutLines : records) {
      let label = '';
      let region = '';
      let prov = '';
      let comuniBlob = '';

      if (useLayout) {
        const s = String(r).replace(/^\d+\s+/, '').trim();
        region = findEarliestMatch(s, regionNames) || '';
        if (!region) {
          skippedGroups++;
          continue;
        }
        const beforeRegion = s.slice(0, s.indexOf(region)).trim();
        const afterRegion = s.slice(s.indexOf(region) + region.length).trim();
        prov = findEarliestMatch(afterRegion, provinceNames) || '';
        if (!prov) {
          skippedGroups++;
          continue;
        }
        label = beforeRegion;
        const afterProv = afterRegion.slice(afterRegion.indexOf(prov) + prov.length).trim();

        const listMatch = afterProv.match(
          /([A-Za-zÀ-ÿ0-9'()./ -]+(?:\s+[A-Za-zÀ-ÿ0-9'()./ -]+)*\s*,\s*[A-Za-zÀ-ÿ0-9'()./ -]+(?:\s+[A-Za-zÀ-ÿ0-9'()./ -]+)*(?:\s*,\s*[A-Za-zÀ-ÿ0-9'()./ -]+(?:\s+[A-Za-zÀ-ÿ0-9'()./ -]+)*)+)/
        );
        comuniBlob = listMatch ? listMatch[1].trim() : '';
      } else {
        label = r.label;
        region = r.region;
        prov = r.prov;
        comuniBlob = r.comuniBlob;
      }

      const codProv = provinceByName.get(prov);
      if (!codProv) {
        console.warn(`SKIP: cod_prov non trovato per provincia "${prov}"`);
        skippedGroups++;
        continue;
      }

      if (!label) {
        // Non bloccare l'import: assegna un nome di fallback (meglio di label vuota in UI/datapack).
        // Tentiamo comunque a popolare i membri; se anche i membri risultano vuoti, verrà skippato dopo.
        label = `Raggruppamento (${region} - ${prov})`;
      }

      if (!comuniBlob) {
        skippedGroups++;
        continue;
      }

      const comuni = comuniBlob
        .split(',')
        .map((x) =>
          x
            .trim()
            // ripulisce eventuali residui numerici ai margini dovuti al layout
            .replace(/^\d[\d.,]*\s+/, '')
            .replace(/\s+\d[\d.,]*$/, '')
            .trim()
        )
        .filter(Boolean);

      const muniMap = await getMuniMapForProv(codProv);
      const members = [];
      for (const c of comuni) {
        const pc = muniMap.get(normKey(c));
        if (!pc) {
          console.warn(`WARN: comune non risolto "${c}" in prov "${prov}" (${region}) — group="${label}"`);
          continue;
        }
        members.push(pc);
      }

      const unique = [...new Set(members)].sort((a, b) => a - b);
      if (!unique.length) {
        console.warn(`SKIP: nessun membro risolto per "${label}" (${region}, ${prov})`);
        skippedGroups++;
        continue;
      }

      const kind = inferKind(label);
      const notes = `Import da elenco ANCI (PDF) via pdftotext; parsing per regione/provincia; record: ${region} / ${prov}.`;

      const slug = `it-${slugify(region)}-${slugify(prov)}-${slugify(label)}`;
      const externalId = `${slugify(region)}:${slugify(prov)}:${slugify(label)}`;

      const groupId = await upsertGroup(client, {
        slug,
        label,
        kind,
        notes,
        source_name: SOURCE_NAME,
        source_url: SOURCE_URL,
        reference_year: REFERENCE_YEAR,
        external_id: externalId,
      });

      if (append) await appendMembers(client, groupId, unique);
      else await replaceMembers(client, groupId, unique);

      okGroups++;
      okMembers += unique.length;
    }

    await client.query('COMMIT');
    console.log(
      `OK: groups=${okGroups} (skipped=${skippedGroups}) members=${okMembers} mode=${append ? 'append' : 'replace'}`
    );
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

