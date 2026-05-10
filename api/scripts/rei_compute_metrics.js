/* eslint-disable no-console */
'use strict';

/**
 * Calcolo metriche spaziali REI dopo popolamento di rei_hiking_routes.
 * Usato da import_rei_hiking_routes.js e import_rei_sentier.js.
 */

async function computeMetrics(client) {
  console.log('\n=== Calcolo metriche spaziali (può richiedere alcuni minuti) ===');

  console.log('  [1/3] Comuni → municipality_rei_hiking_routes ...');
  await client.query('TRUNCATE municipality_rei_hiking_routes');
  await client.query(`
    INSERT INTO municipality_rei_hiking_routes (pro_com, osm2cai_id, sda, km_inside)
    SELECT
      m.pro_com,
      hr.id,
      hr.sda,
      ST_Length(ST_Intersection(m.geom, hr.geom)::geography) / 1000.0 AS km_inside
    FROM municipalities m
    JOIN rei_hiking_routes hr ON ST_Intersects(m.geom, hr.geom)
    WHERE ST_Length(ST_Intersection(m.geom, hr.geom)::geography) > 0
  `);

  console.log('  [2a/3] Comuni → municipality_rei_stats ...');
  await client.query('TRUNCATE municipality_rei_stats');
  await client.query(`
    INSERT INTO municipality_rei_stats (pro_com, sda, km_inside)
    SELECT pro_com, sda, SUM(km_inside)
    FROM municipality_rei_hiking_routes
    GROUP BY pro_com, sda
  `);

  const { rowCount: paCount } = await client.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='protected_areas' LIMIT 1"
  );
  if (paCount > 0) {
    console.log('  [2/3] Parchi → protected_area_rei_hiking_routes ...');
    await client.query('TRUNCATE protected_area_rei_hiking_routes');
    await client.query(`
      INSERT INTO protected_area_rei_hiking_routes (protected_area_id, osm2cai_id, sda, km_inside)
      SELECT
        pa.id,
        hr.id,
        hr.sda,
        ST_Length(ST_Intersection(pa.geom, hr.geom)::geography) / 1000.0 AS km_inside
      FROM protected_areas pa
      JOIN rei_hiking_routes hr ON ST_Intersects(pa.geom, hr.geom)
      WHERE ST_Length(ST_Intersection(pa.geom, hr.geom)::geography) > 0
    `);

    console.log('  [2b/3] Parchi → protected_area_rei_stats ...');
    await client.query('TRUNCATE protected_area_rei_stats');
    await client.query(`
      INSERT INTO protected_area_rei_stats (protected_area_id, sda, km_inside)
      SELECT protected_area_id, sda, SUM(km_inside)
      FROM protected_area_rei_hiking_routes
      GROUP BY protected_area_id, sda
    `);
  } else {
    console.log('  [2/3] Parchi: tabella protected_areas assente, skip.');
  }

  console.log('  [3/3] Gruppi territoriali → territorial_group_rei_stats ...');
  await client.query('TRUNCATE territorial_group_rei_stats');
  await client.query(`
    INSERT INTO territorial_group_rei_stats (group_id, sda, km_inside)
    SELECT g.id, hr.sda,
           SUM(ST_Length(ST_Intersection(group_geom.geom, hr.geom)::geography) / 1000.0) AS km_inside
    FROM territorial_groups g
    JOIN LATERAL (
      SELECT ST_UnaryUnion(ST_Collect(m.geom)) AS geom
      FROM territorial_group_members tgm
      JOIN municipalities m ON m.pro_com = tgm.pro_com
      WHERE tgm.group_id = g.id
    ) group_geom ON TRUE
    JOIN rei_hiking_routes hr ON ST_Intersects(group_geom.geom, hr.geom)
    WHERE ST_Length(ST_Intersection(group_geom.geom, hr.geom)::geography) > 0
    GROUP BY g.id, hr.sda
  `);

  const { rows: mcStats } = await client.query('SELECT count(*)::int AS n FROM municipality_rei_stats');
  const { rows: paStats } = await client.query('SELECT count(*)::int AS n FROM protected_area_rei_stats');
  const { rows: tgStats } = await client.query('SELECT count(*)::int AS n FROM territorial_group_rei_stats');
  console.log(
    `OK metriche: comuni=${mcStats[0].n} righe stats, parchi=${paStats[0].n}, gruppi=${tgStats[0].n}`
  );
}

module.exports = { computeMetrics };
