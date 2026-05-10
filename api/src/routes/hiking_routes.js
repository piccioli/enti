const { Router } = require('express');
const db = require('../db');

const router = Router();

/** Sentieri REI che intersecano un comune. */
router.get('/municipalities/:procom/rei-hiking-routes', async (req, res, next) => {
  try {
    const procom = parseInt(req.params.procom, 10);
    if (!Number.isFinite(procom)) return res.status(400).json({ error: 'Invalid pro_com' });

    const { rows } = await db.query(
      `SELECT hr.id,
              hr.ref,
              hr.ref_rei,
              hr.name,
              hr.sda,
              hr.cai_scale,
              hr.distance_km,
              hr.gpx_url,
              hr.validation_date,
              mhr.km_inside
       FROM municipality_rei_hiking_routes mhr
       JOIN rei_hiking_routes hr ON hr.id = mhr.osm2cai_id
       WHERE mhr.pro_com = $1
       ORDER BY mhr.km_inside DESC`,
      [procom]
    );

    res.json({ total: rows.length, items: rows });
  } catch (err) {
    next(err);
  }
});

/** Sentieri REI che intersecano un parco. */
router.get('/protected-areas/:id/rei-hiking-routes', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

    const { rows } = await db.query(
      `SELECT hr.id,
              hr.ref,
              hr.ref_rei,
              hr.name,
              hr.sda,
              hr.cai_scale,
              hr.distance_km,
              hr.gpx_url,
              hr.validation_date,
              pahr.km_inside
       FROM protected_area_rei_hiking_routes pahr
       JOIN rei_hiking_routes hr ON hr.id = pahr.osm2cai_id
       WHERE pahr.protected_area_id = $1
       ORDER BY pahr.km_inside DESC`,
      [id]
    );

    res.json({ total: rows.length, items: rows });
  } catch (err) {
    next(err);
  }
});

/** Singolo sentiero REI come Feature GeoJSON. */
router.get('/rei-hiking-routes/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

    const { rows } = await db.query(
      `SELECT id, relation_id, ref, ref_rei, name, sda,
              cai_scale, cai_scale_string,
              from_loc, to_loc,
              city_from, city_from_istat, region_from, region_from_istat,
              city_to, city_to_istat, region_to, region_to_istat,
              distance_km, ascent_m, descent_m,
              ele_min_m, ele_max_m, ele_from_m, ele_to_m,
              duration_forward_min, duration_backward_min,
              roundtrip, abstract, gpx_url,
              validation_date, survey_date, osm2cai_status,
              source_url, updated_at,
              ST_AsGeoJSON(geom)::json AS geometry
       FROM rei_hiking_routes
       WHERE id = $1`,
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
