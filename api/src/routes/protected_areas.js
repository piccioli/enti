const { Router } = require('express');
const db = require('../db');

const router = Router();

const REI_STATS_JOIN = `
  LEFT JOIN (
    SELECT protected_area_id,
           COALESCE(SUM(km_inside) FILTER (WHERE sda = 3), 0) AS km_sentieri_sda3,
           COALESCE(SUM(km_inside) FILTER (WHERE sda = 4), 0) AS km_sentieri_sda4
    FROM protected_area_rei_stats
    GROUP BY protected_area_id
  ) rei ON rei.protected_area_id = p.id`;

/** Elenco paginato + filtri geografici (incrocio con regione/provincia). */
router.get('/', async (req, res, next) => {
  try {
    const reg = req.query.reg ? parseInt(req.query.reg, 10) : null;
    const prov = req.query.prov ? parseInt(req.query.prov, 10) : null;
    const q = req.query.q ? req.query.q.trim() : null;
    const withReiRaw = req.query.with_rei;
    const withRei = withReiRaw === '1' || withReiRaw === 'true' ? true
      : withReiRaw === '0' || withReiRaw === 'false' ? false : null;
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
    if (withRei === true) {
      conditions.push('COALESCE(rei.km_sentieri_sda3, 0) + COALESCE(rei.km_sentieri_sda4, 0) > 0');
    } else if (withRei === false) {
      conditions.push('(rei.protected_area_id IS NULL OR COALESCE(rei.km_sentieri_sda3, 0) + COALESCE(rei.km_sentieri_sda4, 0) = 0)');
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    params.push(limit, offset);
    const limIdx = params.length - 1;
    const offIdx = params.length;

    const [countResult, dataResult] = await Promise.all([
      db.query(`SELECT count(*)::int FROM protected_areas p ${REI_STATS_JOIN} ${where}`, params.slice(0, params.length - 2)),
      db.query(
        `SELECT p.id,
                p.external_code,
                p.name,
                p.area_type,
                p.source_name,
                ST_Area(p.geom::geography) / 1e6 AS area_km2,
                COALESCE(rei.km_sentieri_sda3, 0) AS km_sentieri_sda3,
                COALESCE(rei.km_sentieri_sda4, 0) AS km_sentieri_sda4,
                COALESCE(rei.km_sentieri_sda3, 0) + COALESCE(rei.km_sentieri_sda4, 0) AS km_sentieri_total,
                (SELECT string_agg(DISTINCT r.den_reg, ', ' ORDER BY r.den_reg)
                   FROM regions r
                   WHERE ST_Intersects(r.geom, p.geom)) AS regions_touched,
                (SELECT string_agg(DISTINCT pr.sigla, ', ' ORDER BY pr.sigla)
                   FROM provinces pr
                   WHERE ST_Intersects(pr.geom, p.geom)) AS provinces_touched,
                (SELECT count(*)::int
                   FROM municipalities mm
                   WHERE ST_Intersects(mm.geom, p.geom)) AS member_count,
                (SELECT COALESCE(SUM(mm.popolazione_residente), 0)::bigint
                   FROM municipalities mm
                   WHERE ST_Intersects(mm.geom, p.geom)) AS population_total
         FROM protected_areas p
         ${REI_STATS_JOIN}
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

/** FeatureCollection per la mappa. Senza parametri: tutte le aree (es. vista Italia). Con reg/prov: filtro spaziale. */
router.get('/geojson', async (req, res, next) => {
  try {
    const prov = req.query.prov ? parseInt(req.query.prov, 10) : null;
    const reg = req.query.reg ? parseInt(req.query.reg, 10) : null;

    let whereClause = '';
    const params = [];
    if (prov != null && !Number.isNaN(prov)) {
      params.push(prov);
      whereClause = `WHERE EXISTS (
        SELECT 1 FROM provinces pr
        WHERE pr.cod_prov = $1 AND ST_Intersects(p.geom, pr.geom)
      )`;
    } else if (reg != null && !Number.isNaN(reg)) {
      params.push(reg);
      whereClause = `WHERE EXISTS (
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
      ${whereClause}
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

/** Comuni che intersecano un'area protetta (per popup elenco). */
router.get('/:id/municipalities', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

    const { rows } = await db.query(
      `SELECT m.pro_com, m.pro_com_t, m.comune, m.cod_prov, m.cod_reg,
              p.sigla, p.den_prov, r.den_reg
       FROM municipalities m
       LEFT JOIN provinces p ON p.cod_prov = m.cod_prov
       LEFT JOIN regions r   ON r.cod_reg  = m.cod_reg
       WHERE ST_Intersects(m.geom, (SELECT geom FROM protected_areas WHERE id = $1))
       ORDER BY m.comune`,
      [id]
    );

    res.json({ id, members: rows });
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
              ST_Area(p.geom::geography) / 1e6 AS area_km2,
              COALESCE(rei.km_sentieri_sda3, 0) AS km_sentieri_sda3,
              COALESCE(rei.km_sentieri_sda4, 0) AS km_sentieri_sda4,
              COALESCE(rei.km_sentieri_sda3, 0) + COALESCE(rei.km_sentieri_sda4, 0) AS km_sentieri_total
       FROM protected_areas p
       ${REI_STATS_JOIN}
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
