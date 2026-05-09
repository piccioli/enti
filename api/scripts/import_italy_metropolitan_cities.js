/* eslint-disable no-console */
'use strict';

/**
 * Crea/aggiorna i raggruppamenti "citta_metropolitane" a partire dalle province (sigle) e
 * popola i membri prendendo tutti i comuni con lo stesso cod_prov.
 *
 * Uso:
 *   docker compose exec api node scripts/import_italy_metropolitan_cities.js
 */

const db = require('../src/db');

const METRO_SIGLE = [
  'BA', // Bari
  'BO', // Bologna
  'CA', // Cagliari
  'CT', // Catania
  'FI', // Firenze
  'GE', // Genova
  'ME', // Messina
  'MI', // Milano
  'NA', // Napoli
  'PA', // Palermo
  'RC', // Reggio Calabria
  'RM', // Roma
  'TO', // Torino
  'VE', // Venezia
];

function slugify(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

async function upsertGroup(client, { slug, label, notes, source_name, reference_year, external_id }) {
  const { rows } = await client.query(
    `INSERT INTO territorial_groups (
       slug, label, group_kind, notes,
       source_name, source_url, reference_year, external_id, is_demo
     )
     VALUES ($1, $2, 'citta_metropolitane', $3, $4, NULL, $5, $6, false)
     ON CONFLICT (slug) DO UPDATE
       SET label = EXCLUDED.label,
           group_kind = EXCLUDED.group_kind,
           notes = EXCLUDED.notes,
           source_name = EXCLUDED.source_name,
           reference_year = EXCLUDED.reference_year,
           external_id = COALESCE(EXCLUDED.external_id, territorial_groups.external_id)
     RETURNING id`,
    [slug, label, notes, source_name, reference_year, external_id]
  );
  return rows[0].id;
}

async function replaceMembers(client, groupId, codProv) {
  await client.query('DELETE FROM territorial_group_members WHERE group_id = $1', [groupId]);
  const { rows } = await client.query(
    `SELECT m.pro_com::int AS pro_com
     FROM municipalities m
     WHERE m.cod_prov = $1
     ORDER BY m.pro_com`,
    [codProv]
  );
  if (!rows.length) return 0;

  const vals = [groupId];
  const parts = [];
  rows.forEach((r, i) => {
    parts.push(`($1, $${i + 2})`);
    vals.push(r.pro_com);
  });
  await client.query(
    `INSERT INTO territorial_group_members (group_id, pro_com)
     VALUES ${parts.join(', ')}
     ON CONFLICT DO NOTHING`,
    vals
  );
  return rows.length;
}

async function main() {
  const client = await db.connect();
  try {
    const { rows: provs } = await client.query(
      `SELECT cod_prov::int AS cod_prov, sigla, den_prov
       FROM provinces
       WHERE sigla = ANY($1::text[])
       ORDER BY sigla`,
      [METRO_SIGLE]
    );

    if (!provs.length) {
      console.warn('Nessuna provincia trovata per le sigle città metropolitane (tabella provinces vuota?).');
      return;
    }

    const nowYear = new Date().getUTCFullYear();
    const refYear = Number.isFinite(nowYear) ? nowYear : null;

    let totalMembers = 0;
    await client.query('BEGIN');

    for (const p of provs) {
      const baseName = p.den_prov || p.sigla;
      const slug = `citta-metropolitana-${slugify(baseName)}`;
      const label = `Città metropolitana di ${baseName}`;
      const notes = 'Derivato dalle province (sigle città metropolitane) e dai comuni per cod_prov.';

      const groupId = await upsertGroup(client, {
        slug,
        label,
        notes,
        source_name: 'derivato-provinces-metro',
        reference_year: refYear,
        external_id: p.sigla,
      });

      totalMembers += await replaceMembers(client, groupId, p.cod_prov);
    }

    await client.query('COMMIT');
    console.log(`OK: importate/aggiornate ${provs.length} città metropolitane; membri inseriti: ${totalMembers}.`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

