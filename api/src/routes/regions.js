const { Router } = require('express');
const db = require('../db');

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT cod_reg, den_reg FROM regions ORDER BY den_reg'
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/geojson', async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT json_build_object(
        'type', 'Feature',
        'properties', json_build_object('cod_reg', cod_reg, 'den_reg', den_reg),
        'geometry', ST_AsGeoJSON(geom)::json
      ) AS feature
      FROM regions
      ORDER BY cod_reg
    `);
    res.json({
      type: 'FeatureCollection',
      features: rows.map((r) => r.feature),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
