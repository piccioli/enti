const { Router } = require('express');
const db = require('../db');

const router = Router();

function parseIdsParam(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  const ids = s.split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => Number.isFinite(n));
  // de-dup + cap to avoid abuse
  return [...new Set(ids)].slice(0, 250);
}

// List with pagination + filters
router.get('/', async (req, res, next) => {
  try {
    const reg = req.query.reg ? parseInt(req.query.reg) : null;
    const prov = req.query.prov ? parseInt(req.query.prov) : null;
    const group = req.query.group ? parseInt(req.query.group) : null;
    const q = req.query.q ? req.query.q.trim() : null;
    const montL131Raw = req.query.montano_l131;
    const montL131Only = montL131Raw === '1' || montL131Raw === 'true';
    const hasContactsRaw = req.query.has_contacts;
    const hasContactsOnly = hasContactsRaw === '1' || hasContactsRaw === 'true';
    const limit = Math.min(parseInt(req.query.limit || '50'), 200);
    const offset = parseInt(req.query.offset || '0');

    const conditions = [];
    const params = [];

    if (reg) { params.push(reg); conditions.push(`m.cod_reg = $${params.length}`); }
    if (prov) { params.push(prov); conditions.push(`m.cod_prov = $${params.length}`); }
    if (group) {
      params.push(group);
      conditions.push(`EXISTS (
        SELECT 1 FROM territorial_group_members t
        WHERE t.group_id = $${params.length} AND t.pro_com = m.pro_com
      )`);
    }
    if (q) { params.push(`%${q}%`); conditions.push(`m.comune ILIKE $${params.length}`); }
    if (montL131Only) { conditions.push('m.comune_montano_l131 = true'); }
    if (hasContactsOnly) {
      conditions.push(`(
        m.sito_web IS NOT NULL OR m.email IS NOT NULL OR m.pec IS NOT NULL OR
        m.telefono IS NOT NULL OR m.codice_fiscale IS NOT NULL OR m.indirizzo_fisico IS NOT NULL
      )`);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    params.push(limit);
    params.push(offset);

    const [countResult, dataResult] = await Promise.all([
      db.query(
        `SELECT count(*)::int FROM municipalities m ${where}`,
        params.slice(0, params.length - 2)
      ),
      db.query(
        `SELECT m.pro_com, m.pro_com_t, m.comune, m.comune_a, m.cc_uts,
                m.cod_prov, m.cod_reg, m.popolazione_residente, m.popolazione_istat_anno,
                m.altitudine_min_sl_m, m.altitudine_max_sl_m, m.altitudine_media_sl_m,
                m.altitudine_centro_municipio_sl_m, m.altitudine_istat_anno,
                m.comune_montano_l131,
                m.sito_web, m.email, m.pec, m.telefono, m.codice_fiscale, m.indirizzo_fisico,
                p.sigla, p.den_prov, r.den_reg
         FROM municipalities m
         LEFT JOIN provinces p ON p.cod_prov = m.cod_prov
         LEFT JOIN regions r ON r.cod_reg = m.cod_reg
         ${where}
         ORDER BY m.comune
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      ),
    ]);

    res.json({ total: countResult.rows[0].count, items: dataResult.rows });
  } catch (err) {
    next(err);
  }
});

// Batch stats for export: areas + minimal info
router.get('/stats', async (req, res, next) => {
  try {
    const ids = parseIdsParam(req.query.ids);
    if (!ids.length) return res.status(400).json({ error: 'ids parameter required' });

    const { rows } = await db.query(
      `SELECT m.pro_com, m.pro_com_t, m.comune, m.cod_prov, m.cod_reg,
              m.popolazione_residente, m.popolazione_istat_anno,
              m.altitudine_min_sl_m, m.altitudine_max_sl_m, m.altitudine_media_sl_m,
              m.altitudine_centro_municipio_sl_m, m.altitudine_istat_anno,
              m.comune_montano_l131,
              m.sito_web, m.email, m.pec, m.telefono, m.codice_fiscale, m.indirizzo_fisico,
              p.sigla, p.den_prov, r.den_reg,
              ST_Area(m.geom::geography) / 1e6 AS area_km2
       FROM municipalities m
       LEFT JOIN provinces p ON p.cod_prov = m.cod_prov
       LEFT JOIN regions r ON r.cod_reg = m.cod_reg
       WHERE m.pro_com = ANY($1::int[])
       ORDER BY m.comune`,
      [ids]
    );

    const totalArea = rows.reduce((acc, r) => acc + (parseFloat(r.area_km2) || 0), 0);
    res.json({
      count: rows.length,
      total_area_km2: totalArea,
      items: rows,
    });
  } catch (err) {
    next(err);
  }
});

// GeoJSON by ids (for export)
router.get('/geojson/by-ids', async (req, res, next) => {
  try {
    const ids = parseIdsParam(req.query.ids);
    if (!ids.length) return res.status(400).json({ error: 'ids parameter required' });

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
      FROM municipalities m
      WHERE m.pro_com = ANY($1::int[])
      ORDER BY m.comune`,
      [ids]
    );

    res.json({ type: 'FeatureCollection', features: rows.map((r) => r.feature) });
  } catch (err) {
    next(err);
  }
});

// GeoJSON for map rendering (requires prov or reg filter)
router.get('/geojson', async (req, res, next) => {
  try {
    const prov = req.query.prov ? parseInt(req.query.prov) : null;
    const reg = req.query.reg ? parseInt(req.query.reg) : null;

    if (!prov && !reg) {
      return res.status(400).json({ error: 'At least one of prov or reg is required' });
    }

    const conditions = [];
    const params = [];
    if (prov) { params.push(prov); conditions.push(`cod_prov = $${params.length}`); }
    else if (reg) { params.push(reg); conditions.push(`cod_reg = $${params.length}`); }

    const where = 'WHERE ' + conditions.join(' AND ');

    const { rows } = await db.query(`
      SELECT json_build_object(
        'type', 'Feature',
        'properties', json_build_object(
          'pro_com', pro_com,
          'pro_com_t', pro_com_t,
          'comune', comune,
          'cod_prov', cod_prov,
          'cod_reg', cod_reg
        ),
        'geometry', ST_AsGeoJSON(geom)::json
      ) AS feature
      FROM municipalities
      ${where}
      ORDER BY comune
    `, params);

    res.json({
      type: 'FeatureCollection',
      features: rows.map((r) => r.feature),
    });
  } catch (err) {
    next(err);
  }
});

// Single municipality detail with geometry
router.get('/:procom', async (req, res, next) => {
  try {
    const procom = parseInt(req.params.procom);
    if (isNaN(procom)) return res.status(400).json({ error: 'Invalid pro_com' });

    const { rows } = await db.query(`
      SELECT m.pro_com, m.pro_com_t, m.comune, m.comune_a, m.cc_uts,
             m.cod_prov, m.cod_reg,
             m.popolazione_residente, m.popolazione_istat_anno,
             m.altitudine_min_sl_m, m.altitudine_max_sl_m, m.altitudine_media_sl_m,
             m.altitudine_centro_municipio_sl_m, m.altitudine_istat_anno,
             m.comune_montano_l131,
             m.sito_web, m.email, m.pec, m.telefono, m.codice_fiscale, m.indirizzo_fisico,
             p.sigla, p.den_prov, p.tipo_uts,
             r.den_reg,
             ST_AsGeoJSON(m.geom)::json AS geometry,
             ST_Area(m.geom::geography) / 1e6 AS area_km2
      FROM municipalities m
      LEFT JOIN provinces p ON p.cod_prov = m.cod_prov
      LEFT JOIN regions r ON r.cod_reg = m.cod_reg
      WHERE m.pro_com = $1
    `, [procom]);

    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const row = rows[0];
    const { geometry, ...properties } = row;
    res.json({ type: 'Feature', properties, geometry });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
