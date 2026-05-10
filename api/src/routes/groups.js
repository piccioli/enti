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

function parseIntParam(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : null;
}

/** GET / — elenco con filtri geografici/testuali opzionali */
router.get('/', async (req, res, next) => {
  try {
    const kind = req.query.kind ? String(req.query.kind).trim() : null;
    const qRaw = req.query.q ? String(req.query.q).trim() : null;
    const ftsReq = req.query.ft != null ? String(req.query.ft) : '';
    const ftsRaw = ftsReq.trim().slice(0, 200);

    const reg = parseIntParam(req.query.reg);
    const prov = parseIntParam(req.query.prov);

    /** @type {{ minLon: number, minLat: number, maxLon: number, maxLat: number } | null} */
    let bbox = null;
    const bboxRaw = req.query.bbox ? String(req.query.bbox).trim() : '';
    if (bboxRaw) {
      const parts = bboxRaw.split(',').map((s) => parseFloat(String(s).trim()));
      const [minLon, minLat, maxLon, maxLat] = parts;
      if (parts.length !== 4 || ![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) {
        return res.status(400).json({ error: 'bbox richiede minLon,minLat,maxLon,maxLat numeriche' });
      }
      if (minLon >= maxLon || minLat >= maxLat) {
        return res.status(400).json({ error: 'bbox invalido (ordine o ampiezza)' });
      }
      bbox = { minLon, minLat, maxLon, maxLat };
    }

    let limit = parseInt(req.query.limit || '50', 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 50;
    limit = Math.min(limit, 500);

    let offset = parseInt(req.query.offset || '0', 10);
    if (!Number.isFinite(offset) || offset < 0) offset = 0;

    const includeExpired =
      req.query.include_expired === '1'
      || String(req.query.include_expired || '').toLowerCase() === 'true';

    const params = [];

    /** @type {string[]} */
    const condsOnG = [];

    if (kind) {
      params.push(kind);
      condsOnG.push(`g.group_kind = $${params.length}`);
    }

    if (ftsRaw) {
      params.push(ftsRaw);
      condsOnG.push(
        `(to_tsvector('italian', coalesce(g.label,'')||' '||coalesce(g.slug,'')) @@ plainto_tsquery('italian', $${params.length}))`
      );
    } else if (qRaw) {
      params.push(`%${qRaw}%`);
      condsOnG.push(`(g.label ILIKE $${params.length} OR g.slug ILIKE $${params.length})`);
    }

    if (!includeExpired) {
      condsOnG.push(`(g.valid_to IS NULL OR g.valid_to >= CURRENT_DATE)`);
    }

    /** Condizioni geografiche sui comuni membri */
    /** @type {string[]} */
    const geoWhere = [];

    if (reg !== null) {
      params.push(reg);
      geoWhere.push(`m.cod_reg = $${params.length}`);
    }
    if (prov !== null) {
      params.push(prov);
      geoWhere.push(`m.cod_prov = $${params.length}`);
    }
    if (bbox !== null) {
      const pi = params.length + 1;
      params.push(bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat);
      geoWhere.push(
        `ST_Intersects(m.geom, ST_MakeEnvelope(`
        + `$${pi}::double precision, $${pi + 1}::double precision, `
        + `$${pi + 2}::double precision, $${pi + 3}::double precision, 4326))`
      );
    }

    const groupWhereSql = condsOnG.length ? `AND (${condsOnG.join(' AND ')})` : '';
    const geoWhereSql = geoWhere.length ? `WHERE ${geoWhere.join(' AND ')}` : '';

    const selectList = `
        g.id, g.slug, g.label, g.group_kind, g.notes,
        g.valid_from, g.valid_to,
        g.source_name, g.source_url, g.reference_year, g.external_id, g.is_demo,
        (SELECT count(*)::int FROM territorial_group_members m2 WHERE m2.group_id = g.id) AS member_count,
        (SELECT string_agg(DISTINCT r.den_reg, ', ' ORDER BY r.den_reg)
           FROM territorial_group_members tgm
           JOIN municipalities mm ON mm.pro_com = tgm.pro_com
           JOIN regions r ON r.cod_reg = mm.cod_reg
           WHERE tgm.group_id = g.id) AS regions_touched,
        (SELECT string_agg(DISTINCT pr.sigla, ', ' ORDER BY pr.sigla)
           FROM territorial_group_members tgm
           JOIN municipalities mm ON mm.pro_com = tgm.pro_com
           JOIN provinces pr ON pr.cod_prov = mm.cod_prov
           WHERE tgm.group_id = g.id) AS provinces_touched,
        (SELECT COALESCE(SUM(mm.popolazione_residente), 0)::bigint
           FROM territorial_group_members tgm
           JOIN municipalities mm ON mm.pro_com = tgm.pro_com
           WHERE tgm.group_id = g.id) AS population_total,
        (SELECT COALESCE(SUM(ST_Area(mm.geom::geography)) / 1e6, 0)::double precision
           FROM territorial_group_members tgm
           JOIN municipalities mm ON mm.pro_com = tgm.pro_com
           WHERE tgm.group_id = g.id) AS area_km2_total,
        (SELECT COALESCE(SUM(s.km_inside), 0)::double precision
           FROM territorial_group_rei_stats s
           WHERE s.group_id = g.id) AS km_sentieri_total`;

    if (geoWhere.length > 0) {
      params.push(limit, offset);
      const limIdx = params.length - 1;
      const offIdx = params.length;
      const { rows } = await db.query(
        `WITH ids AS (
          SELECT DISTINCT g.id AS id
          FROM territorial_groups g
          INNER JOIN territorial_group_members t ON t.group_id = g.id
          INNER JOIN municipalities m ON m.pro_com = t.pro_com
          ${geoWhereSql}
          ${groupWhereSql}
        )
        SELECT ${selectList}
        FROM territorial_groups g
        INNER JOIN ids i ON i.id = g.id
        ORDER BY g.group_kind, g.label
        LIMIT $${limIdx} OFFSET $${offIdx}`,
        params
      );

      return res.json(rows.map((r) => ({
        ...r,
        kind_label: KIND_LABELS[r.group_kind] || r.group_kind,
      })));
    }

    params.push(limit, offset);
    const limIdx = params.length - 1;
    const offIdx = params.length;

    const wherePlain = condsOnG.length ? `WHERE ${condsOnG.join(' AND ')}` : '';

    const { rows } = await db.query(
      `SELECT ${selectList.replace(/\n\s+/g, ' ')}
       FROM territorial_groups g
       ${wherePlain}
       ORDER BY g.group_kind, g.label
       LIMIT $${limIdx} OFFSET $${offIdx}`,
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
      `SELECT g.id, g.slug, g.label, g.group_kind, g.notes,
              g.valid_from, g.valid_to, g.created_at,
              g.source_name, g.source_url, g.reference_year, g.external_id, g.is_demo
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
