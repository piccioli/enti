const { Router } = require('express');
const db = require('../db');

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const reg = req.query.reg ? parseInt(req.query.reg) : null;
    const { rows } = await db.query(
      `SELECT cod_prov, cod_reg, sigla, den_prov, tipo_uts
       FROM provinces
       WHERE ($1::int IS NULL OR cod_reg = $1)
       ORDER BY den_prov`,
      [reg]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/geojson', async (req, res, next) => {
  try {
    const reg = req.query.reg ? parseInt(req.query.reg) : null;
    if (!reg) return res.status(400).json({ error: 'reg parameter required' });

    const { rows } = await db.query(`
      SELECT json_build_object(
        'type', 'Feature',
        'properties', json_build_object(
          'cod_prov', cod_prov,
          'cod_reg', cod_reg,
          'den_prov', den_prov,
          'sigla', sigla,
          'tipo_uts', tipo_uts
        ),
        'geometry', ST_AsGeoJSON(geom)::json
      ) AS feature
      FROM provinces
      WHERE cod_reg = $1
      ORDER BY den_prov
    `, [reg]);

    res.json({
      type: 'FeatureCollection',
      features: rows.map((r) => r.feature),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
