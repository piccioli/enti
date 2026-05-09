const { Router } = require('express');
const db = require('../db');

const router = Router();

/** Elenco paginato + filtri geografici (incrocio con regione/provincia). */
router.get('/', async (req, res, next) => {
  try {
    const reg = req.query.reg ? parseInt(req.query.reg, 10) : null;
    const prov = req.query.prov ? parseInt(req.query.prov, 10) : null;
    const q = req.query.q ? req.query.q.trim() : null;
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const offset = parseInt(req.query.offset || '0', 10);

    const conditions = [];
    const params = [];

    if (q) {
      params.push(`%${q}%`);
      conditions.push(`p.name ILIKE $${params.length}`);
    }
    if (reg != null && !Number.isNaN(reg)) {
      params.push(reg);
      conditions.push(`
        EXISTS (
          SELECT 1 FROM regions r
          WHERE r.cod_reg = $${params.length} AND ST_Intersects(p.geom, r.geom)
        )`);
    }
    if (prov != null && !Number.isNaN(prov)) {
      params.push(prov);
      conditions.push(`
        EXISTS (
          SELECT 1 FROM provinces pr
          WHERE pr.cod_prov = $${params.length} AND ST_Intersects(p.geom, pr.geom)
        )`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    params.push(limit, offset);
    const limIdx = params.length - 1;
    const offIdx = params.length;

    const [countResult, dataResult] = await Promise.all([
      db.query(`SELECT count(*)::int FROM protected_areas p ${where}`, params.slice(0, params.length - 2)),
      db.query(
        `SELECT p.id,
                p.external_code,
                p.name,
                p.area_type,
                p.source_name,
                ST_Area(p.geom::geography) / 1e6 AS area_km2
         FROM protected_areas p
         ${where}
         ORDER BY p.name
         LIMIT $${limIdx} OFFSET $${offIdx}`,
        params
      ),
    ]);

    res.json({ total: countResult.rows[0].count, items: dataResult.rows });
  } catch (err) {
    next(err);
  }
});

/** FeatureCollection leggere per la mappa (filtro regione o provincia obbligatorio). */
router.get('/geojson', async (req, res, next) => {
  try {
    const prov = req.query.prov ? parseInt(req.query.prov, 10) : null;
    const reg = req.query.reg ? parseInt(req.query.reg, 10) : null;

    if (!prov && !reg) {
      return res.status(400).json({ error: 'At least one of prov or reg is required' });
    }

    let where;
    const params = [];
    if (prov != null && !Number.isNaN(prov)) {
      params.push(prov);
      where = `EXISTS (
        SELECT 1 FROM provinces pr
        WHERE pr.cod_prov = $1 AND ST_Intersects(p.geom, pr.geom)
      )`;
    } else {
      params.push(reg);
      where = `EXISTS (
        SELECT 1 FROM regions r
        WHERE r.cod_reg = $1 AND ST_Intersects(p.geom, r.geom)
      )`;
    }

    const { rows } = await db.query(
      `
      SELECT json_build_object(
        'type', 'Feature',
        'properties', json_build_object(
          'id', p.id,
          'external_code', p.external_code,
          'name', p.name,
          'area_type', p.area_type
        ),
        'geometry', ST_AsGeoJSON(p.geom)::json
      ) AS feature
      FROM protected_areas p
      WHERE ${where}
      ORDER BY p.name
      `,
      params
    );

    res.json({
      type: 'FeatureCollection',
      features: rows.map((r) => r.feature),
    });
  } catch (err) {
    next(err);
  }
});

/** Singola area con geometria GeoJSON Feature. */
router.get('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

    const { rows } = await db.query(
      `SELECT p.id,
              p.external_code,
              p.name,
              p.area_type,
              p.source_name,
              ST_AsGeoJSON(p.geom)::json AS geometry,
              ST_Area(p.geom::geography) / 1e6 AS area_km2
       FROM protected_areas p
       WHERE p.id = $1`,
      [id]
    );

    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    const row = rows[0];
    const { geometry, ...properties } = row;
    res.json({ type: 'Feature', properties, geometry });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
