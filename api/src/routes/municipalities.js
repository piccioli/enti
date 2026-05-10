const ExcelJS = require('exceljs');
const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');

const router = Router();

const EXPORT_XLSX_WINDOW_MS = 60_000;
const EXPORT_XLSX_MAX = parseInt(process.env.MUNICIPALITIES_EXPORT_XLSX_RATELIMIT_MAX || '20', 10);
const exportXlsxLimiter = rateLimit({
  windowMs: EXPORT_XLSX_WINDOW_MS,
  max: Number.isFinite(EXPORT_XLSX_MAX) && EXPORT_XLSX_MAX > 0 ? EXPORT_XLSX_MAX : 20,
  standardHeaders: true,
  legacyHeaders: false,
});

const EXPORT_MAX_ROWS = Math.min(
  Math.max(parseInt(process.env.MUNICIPALITIES_EXPORT_MAX_ROWS || '12000', 10) || 12000, 100),
  50000
);

function parseIdsParam(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  const ids = s.split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => Number.isFinite(n));
  // de-dup + cap to avoid abuse
  return [...new Set(ids)].slice(0, 250);
}

const REI_STATS_JOIN = `
  LEFT JOIN (
    SELECT pro_com,
           COALESCE(SUM(km_inside) FILTER (WHERE sda = 3), 0) AS km_sentieri_sda3,
           COALESCE(SUM(km_inside) FILTER (WHERE sda = 4), 0) AS km_sentieri_sda4
    FROM municipality_rei_stats
    GROUP BY pro_com
  ) rei ON rei.pro_com = m.pro_com`;

/** @param {Record<string, unknown>} q */
function parseMunicipalityListFilters(q) {
  const reg = q.reg ? parseInt(String(q.reg), 10) : null;
  const prov = q.prov ? parseInt(String(q.prov), 10) : null;
  const group = q.group ? parseInt(String(q.group), 10) : null;
  const searchQ = q.q ? String(q.q).trim() : null;
  const groupId = group != null && !Number.isNaN(group) ? group : null;
  const montL131Raw = q.montano_l131;
  const montL131Only = montL131Raw === '1' || montL131Raw === 'true';
  const hasContactsRaw = q.has_contacts;
  const hasContactsOnly = hasContactsRaw === '1' || hasContactsRaw === 'true';
  const withReiRaw = q.with_rei;
  const withRei = withReiRaw === '1' || withReiRaw === 'true' ? true
    : withReiRaw === '0' || withReiRaw === 'false' ? false : null;

  const conditions = [];
  const params = [];

  if (reg != null && !Number.isNaN(reg)) { params.push(reg); conditions.push(`m.cod_reg = $${params.length}`); }
  if (prov != null && !Number.isNaN(prov)) { params.push(prov); conditions.push(`m.cod_prov = $${params.length}`); }
  if (groupId) {
    params.push(groupId);
    conditions.push(`EXISTS (
        SELECT 1 FROM territorial_group_members t
        WHERE t.group_id = $${params.length} AND t.pro_com = m.pro_com
      )`);
  }
  if (searchQ) { params.push(`%${searchQ}%`); conditions.push(`m.comune ILIKE $${params.length}`); }
  if (montL131Only) { conditions.push('m.comune_montano_l131 = true'); }
  if (hasContactsOnly) {
    conditions.push(`(
        m.sito_web IS NOT NULL OR m.email IS NOT NULL OR m.pec IS NOT NULL OR
        m.telefono IS NOT NULL OR m.codice_fiscale IS NOT NULL OR m.indirizzo_fisico IS NOT NULL
      )`);
  }
  if (withRei === true) {
    conditions.push('COALESCE(rei.km_sentieri_sda3, 0) + COALESCE(rei.km_sentieri_sda4, 0) > 0');
  } else if (withRei === false) {
    conditions.push('(rei.pro_com IS NULL OR COALESCE(rei.km_sentieri_sda3, 0) + COALESCE(rei.km_sentieri_sda4, 0) = 0)');
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  return { where, params };
}

// List with pagination + filters
router.get('/', async (req, res, next) => {
  try {
    const { where, params: filterParams } = parseMunicipalityListFilters(req.query);
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const offset = parseInt(req.query.offset || '0', 10);

    const params = filterParams.slice();
    params.push(limit);
    params.push(offset);

    const [countResult, dataResult] = await Promise.all([
      db.query(
        `SELECT count(*)::int FROM municipalities m ${REI_STATS_JOIN} ${where}`,
        params.slice(0, -2)
      ),
      db.query(
        `SELECT m.pro_com, m.pro_com_t, m.comune, m.comune_a, m.cc_uts,
                m.cod_prov, m.cod_reg, m.popolazione_residente, m.popolazione_istat_anno,
                m.altitudine_min_sl_m, m.altitudine_max_sl_m, m.altitudine_media_sl_m,
                m.altitudine_centro_municipio_sl_m, m.altitudine_istat_anno,
                m.comune_montano_l131,
                m.sito_web, m.email, m.pec, m.telefono, m.codice_fiscale, m.indirizzo_fisico,
                p.sigla, p.den_prov, r.den_reg,
                COALESCE(rei.km_sentieri_sda3, 0) AS km_sentieri_sda3,
                COALESCE(rei.km_sentieri_sda4, 0) AS km_sentieri_sda4,
                COALESCE(rei.km_sentieri_sda3, 0) + COALESCE(rei.km_sentieri_sda4, 0) AS km_sentieri_total
         FROM municipalities m
         LEFT JOIN provinces p ON p.cod_prov = m.cod_prov
         LEFT JOIN regions r ON r.cod_reg = m.cod_reg
         ${REI_STATS_JOIN}
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

// Batch stats for export: areas + minimal info (+ datapack “business” + REI)
router.get('/stats', async (req, res, next) => {
  try {
    const ids = parseIdsParam(req.query.ids);
    if (!ids.length) return res.status(400).json({ error: 'ids parameter required' });

    const { rows } = await db.query(
      `SELECT m.pro_com, m.pro_com_t, m.comune, m.comune_a, m.cc_uts,
              m.cod_prov, m.cod_reg,
              m.popolazione_residente, m.popolazione_istat_anno,
              m.altitudine_min_sl_m, m.altitudine_max_sl_m, m.altitudine_media_sl_m,
              m.altitudine_centro_municipio_sl_m, m.altitudine_istat_anno,
              m.comune_montano_l131,
              m.sito_web, m.email, m.pec, m.telefono, m.codice_fiscale, m.indirizzo_fisico,
              p.sigla, p.den_prov, r.den_reg,
              COALESCE(rei.km_sentieri_sda3, 0) AS km_sentieri_sda3,
              COALESCE(rei.km_sentieri_sda4, 0) AS km_sentieri_sda4,
              COALESCE(rei.km_sentieri_sda3, 0) + COALESCE(rei.km_sentieri_sda4, 0) AS km_sentieri_total,
              ST_Area(m.geom::geography) / 1e6 AS area_km2
       FROM municipalities m
       LEFT JOIN provinces p ON p.cod_prov = m.cod_prov
       LEFT JOIN regions r ON r.cod_reg = m.cod_reg
       ${REI_STATS_JOIN}
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

/** XLSX export (stessi filtri della lista GET /), max righe e rate-limit dedicati */
router.get('/export.xlsx', exportXlsxLimiter, async (req, res, next) => {
  try {
    const { where, params: filterParams } = parseMunicipalityListFilters(req.query);

    const { rows: countRows } = await db.query(
      `SELECT count(*)::int FROM municipalities m ${REI_STATS_JOIN} ${where}`,
      filterParams
    );
    const total = countRows[0].count;
    if (total > EXPORT_MAX_ROWS) {
      return res.status(413).json({
        error: 'Too many rows for export',
        count: total,
        max: EXPORT_MAX_ROWS,
      });
    }

    const { rows } = await db.query(
      `SELECT m.pro_com, m.pro_com_t, m.comune, m.comune_a, m.cc_uts,
              m.cod_prov, m.cod_reg, m.popolazione_residente, m.popolazione_istat_anno,
              m.altitudine_min_sl_m, m.altitudine_max_sl_m, m.altitudine_media_sl_m,
              m.altitudine_centro_municipio_sl_m, m.altitudine_istat_anno,
              m.comune_montano_l131,
              m.sito_web, m.email, m.pec, m.telefono, m.codice_fiscale, m.indirizzo_fisico,
              p.sigla, p.den_prov, r.den_reg,
              COALESCE(rei.km_sentieri_sda3, 0) AS km_sentieri_sda3,
              COALESCE(rei.km_sentieri_sda4, 0) AS km_sentieri_sda4,
              COALESCE(rei.km_sentieri_sda3, 0) + COALESCE(rei.km_sentieri_sda4, 0) AS km_sentieri_total
       FROM municipalities m
       LEFT JOIN provinces p ON p.cod_prov = m.cod_prov
       LEFT JOIN regions r ON r.cod_reg = m.cod_reg
       ${REI_STATS_JOIN}
       ${where}
       ORDER BY m.comune`,
      filterParams
    );

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Comuni', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = [
      { header: 'Comune', key: 'comune', width: 28 },
      { header: 'Prov', key: 'sigla', width: 6 },
      { header: 'Regione', key: 'den_reg', width: 22 },
      { header: 'Abitanti', key: 'popolazione_residente', width: 12 },
      { header: 'Quota media m', key: 'altitudine_media_sl_m', width: 14 },
      { header: 'L.131 montano', key: 'comune_montano_l131', width: 12 },
      { header: 'PEC', key: 'pec_flag', width: 6 },
      { header: 'Info contatti', key: 'has_info', width: 12 },
      { header: 'Sentieri km', key: 'km_sentieri_total', width: 12 },
      { header: 'Cod. ISTAT', key: 'pro_com_t', width: 12 },
    ];

    for (const m of rows) {
      const hasInfo = !!(m.sito_web || m.email || m.pec || m.telefono || m.codice_fiscale || m.indirizzo_fisico);
      ws.addRow({
        comune: m.comune,
        sigla: m.sigla || '',
        den_reg: m.den_reg || '',
        popolazione_residente: m.popolazione_residente,
        altitudine_media_sl_m: m.altitudine_media_sl_m,
        comune_montano_l131: m.comune_montano_l131 ? 'Sì' : '',
        pec_flag: m.pec ? 'Sì' : '',
        has_info: hasInfo ? 'Sì' : '',
        km_sentieri_total: parseFloat(m.km_sentieri_total) || 0,
        pro_com_t: m.pro_com_t != null ? String(m.pro_com_t) : String(m.pro_com),
      });
    }

    const buf = await wb.xlsx.writeBuffer();
    const fname = exportMunicipalitiesFilename(req.query);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"; filename*=UTF-8''${encodeURIComponent(fname)}`);
    res.send(Buffer.from(buf));
  } catch (err) {
    next(err);
  }
});

function exportMunicipalitiesFilename(q) {
  const parts = ['comuni'];
  if (q.reg) parts.push(`reg${q.reg}`);
  if (q.prov) parts.push(`prov${q.prov}`);
  if (q.group) parts.push(`grp${q.group}`);
  if (q.montano_l131 === '1' || q.montano_l131 === 'true') parts.push('montano');
  if (q.has_contacts === '1' || q.has_contacts === 'true') parts.push('contatti');
  if (q.with_rei === '1' || q.with_rei === 'true') parts.push('rei');
  const d = new Date();
  const ts = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  parts.push(ts);
  return `${parts.join('_').replace(/[^\w.\-]+/g, '_')}.xlsx`;
}

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
             ST_Area(m.geom::geography) / 1e6 AS area_km2,
             COALESCE(rei.km_sentieri_sda3, 0) AS km_sentieri_sda3,
             COALESCE(rei.km_sentieri_sda4, 0) AS km_sentieri_sda4,
             COALESCE(rei.km_sentieri_sda3, 0) + COALESCE(rei.km_sentieri_sda4, 0) AS km_sentieri_total
      FROM municipalities m
      LEFT JOIN provinces p ON p.cod_prov = m.cod_prov
      LEFT JOIN regions r ON r.cod_reg = m.cod_reg
      ${REI_STATS_JOIN}
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
