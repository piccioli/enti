const { Router } = require('express');
const db = require('../db');

const router = Router();

const KIND_LABELS = {
  unioni_di_comuni: 'Unione di comuni',
  unioni_montane: 'Unione montana',
  comunita_montane: 'Comunità montana',
  consorzi: 'Consorzio',
  citta_metropolitane: 'Città metropolitana / area vasta',
  parchi_e_riserve: 'Parco / riserva',
  gal_leader: 'GAL / LEADER',
  aree_interne: 'Area interna / strategia',
  altro: 'Altro',
};

function isNumericId(s) {
  return /^\d+$/.test(String(s));
}

function resolveGroupClause(idParam, params) {
  if (isNumericId(idParam)) {
    params.push(parseInt(idParam, 10));
    return `g.id = $${params.length}`;
  }
  params.push(idParam);
  return `g.slug = $${params.length}`;
}

/** GET / — elenco con filtri opzionali */
router.get('/', async (req, res, next) => {
  try {
    const kind = req.query.kind ? String(req.query.kind).trim() : null;
    const q = req.query.q ? String(req.query.q).trim() : null;

    const params = [];
    const conds = [];
    if (kind) {
      params.push(kind);
      conds.push(`g.group_kind = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      conds.push(`(g.label ILIKE $${params.length} OR g.slug ILIKE $${params.length})`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const { rows } = await db.query(
      `SELECT g.id, g.slug, g.label, g.group_kind, g.notes,
              (SELECT count(*)::int FROM territorial_group_members m WHERE m.group_id = g.id) AS member_count
       FROM territorial_groups g
       ${where}
       ORDER BY g.group_kind, g.label`,
      params
    );

    res.json(rows.map((r) => ({
      ...r,
      kind_label: KIND_LABELS[r.group_kind] || r.group_kind,
    })));
  } catch (err) {
    next(err);
  }
});

router.get('/meta/kinds', (_req, res) => {
  res.json(
    Object.entries(KIND_LABELS).map(([id, label]) => ({ id, label }))
  );
});

/** GET /:id/municipalities/geojson — FeatureCollection dei comuni membri */
router.get('/:id/municipalities/geojson', async (req, res, next) => {
  try {
    const params = [];
    const clause = resolveGroupClause(req.params.id, params);

    const { rows: idRows } = await db.query(
      `SELECT g.id, g.slug, g.label, g.group_kind
       FROM territorial_groups g
       WHERE ${clause}`,
      params
    );

    if (!idRows.length) {
      return res.status(404).json({ error: 'Gruppo non trovato' });
    }

    const g = idRows[0];

    const { rows } = await db.query(
      `SELECT json_build_object(
        'type', 'Feature',
        'properties', json_build_object(
          'pro_com', m.pro_com,
          'pro_com_t', m.pro_com_t,
          'comune', m.comune,
          'cod_prov', m.cod_prov,
          'cod_reg', m.cod_reg
        ),
        'geometry', ST_AsGeoJSON(m.geom)::json
      ) AS feature
      FROM territorial_group_members t
      JOIN municipalities m ON m.pro_com = t.pro_com
      WHERE t.group_id = $1
      ORDER BY m.comune`,
      [g.id]
    );

    res.json({
      type: 'FeatureCollection',
      properties: {
        group_id: g.id,
        slug: g.slug,
        label: g.label,
        group_kind: g.group_kind,
        kind_label: KIND_LABELS[g.group_kind] || g.group_kind,
        member_count: rows.length,
      },
      features: rows.map((r) => r.feature),
    });
  } catch (err) {
    next(err);
  }
});

/** GET /:id/geojson — unione geometrie dei comuni aderenti */
router.get('/:id/geojson', async (req, res, next) => {
  try {
    const params = [];
    const clause = resolveGroupClause(req.params.id, params);

    const { rows: idRows } = await db.query(
      `SELECT g.id FROM territorial_groups g WHERE ${clause}`,
      params
    );

    if (!idRows.length) {
      return res.status(404).json({ error: 'Gruppo non trovato' });
    }

    const groupId = idRows[0].id;

    const { rows } = await db.query(
      `SELECT ST_AsGeoJSON(ST_UnaryUnion(ST_Collect(m.geom)))::json AS geometry,
              count(*)::int AS n
       FROM territorial_group_members t
       JOIN municipalities m ON m.pro_com = t.pro_com
       WHERE t.group_id = $1`,
      [groupId]
    );

    const row = rows[0];
    if (!row || !row.n) {
      return res.json({
        type: 'Feature',
        properties: { group_id: groupId, member_count: 0 },
        geometry: null,
      });
    }

    if (!row.geometry) {
      return res.json({
        type: 'Feature',
        properties: { group_id: groupId, member_count: row.n },
        geometry: null,
      });
    }

    const { rows: gmeta } = await db.query(
      'SELECT slug, label, group_kind FROM territorial_groups WHERE id = $1',
      [groupId]
    );

    res.json({
      type: 'Feature',
      properties: {
        group_id: groupId,
        slug: gmeta[0].slug,
        label: gmeta[0].label,
        group_kind: gmeta[0].group_kind,
        kind_label: KIND_LABELS[gmeta[0].group_kind] || gmeta[0].group_kind,
        member_count: row.n,
      },
      geometry: row.geometry,
    });
  } catch (err) {
    next(err);
  }
});

/** GET /:id — dettaglio + comuni */
router.get('/:id', async (req, res, next) => {
  try {
    const params = [];
    const clause = resolveGroupClause(req.params.id, params);

    const { rows: groups } = await db.query(
      `SELECT g.id, g.slug, g.label, g.group_kind, g.notes, g.valid_from, g.valid_to, g.created_at
       FROM territorial_groups g
       WHERE ${clause}`,
      params
    );

    if (!groups.length) {
      return res.status(404).json({ error: 'Gruppo non trovato' });
    }

    const g = groups[0];

    const { rows: statsRows } = await db.query(
      `SELECT count(*)::int AS member_count,
              coalesce(sum(ST_Area(m.geom::geography)) / 1e6, 0)::double precision AS area_km2
       FROM territorial_group_members t
       JOIN municipalities m ON m.pro_com = t.pro_com
       WHERE t.group_id = $1`,
      [g.id]
    );

    const stats = statsRows[0] || { member_count: 0, area_km2: 0 };

    const { rows: members } = await db.query(
      `SELECT m.pro_com, m.pro_com_t, m.comune, m.comune_a, m.cod_prov, m.cod_reg,
              p.sigla, p.den_prov, r.den_reg
       FROM territorial_group_members t
       JOIN municipalities m ON m.pro_com = t.pro_com
       LEFT JOIN provinces p ON p.cod_prov = m.cod_prov
       LEFT JOIN regions r ON r.cod_reg = m.cod_reg
       WHERE t.group_id = $1
       ORDER BY m.comune`,
      [g.id]
    );

    res.json({
      ...g,
      kind_label: KIND_LABELS[g.group_kind] || g.group_kind,
      member_count: stats.member_count,
      area_km2: stats.area_km2,
      members,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
