#!/usr/bin/env bash
# Esporta un "datapack" (GeoJSON + JSON + manifest) da un Postgres già popolato dal loader standard.
#
# Variabili:
#   DATAPACK_DIR   directory di output (default: /datapack)
#   ISTAT_YEAR     anno confini/metadata (solo manifest; default dal loader env o 2026)
#   CREATE_ZIP     1 = crea anche un .zip nella directory padre (default: 0)
#
# Esempi ( dalla root progetto sul host ):
#   docker compose run --rm -v "$(pwd)/datapack-dist:/datapack" loader bash /loader/export_datapack.sh
#
set -euo pipefail

OUT="${DATAPACK_DIR:-/datapack}"
mkdir -p "${OUT}"

YEAR="${ISTAT_YEAR:-2026}"
NOW="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

PG_CONN="PG:host=${PGHOST:-db} port=${PGPORT:-5432} dbname=${PGDATABASE} user=${PGUSER} password=${PGPASSWORD}"

COUNT=$(PGPASSWORD="${PGPASSWORD}" psql -h "${PGHOST:-db}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" \
  -tAc "SELECT count(*) FROM municipalities")

if [[ -z "${COUNT}" || "${COUNT}" == "0" ]]; then
  echo "ERROR: nessun comune in municipalities. Esegui prima load.sh (--force) sul database." >&2
  exit 1
fi

echo "=== Export datapack (${YEAR}) → ${OUT} (${COUNT} comuni) ==="

HAS_PA="$(PGPASSWORD="${PGPASSWORD}" psql -h "${PGHOST:-db}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" -tAc \
  "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='protected_areas')")"
PA_COUNT=0
if [[ "${HAS_PA}" == "t" ]]; then
  PA_COUNT="$(PGPASSWORD="${PGPASSWORD}" psql -h "${PGHOST:-db}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" -tAc "SELECT count(*)::bigint FROM protected_areas")"
fi

HAS_REI="$(PGPASSWORD="${PGPASSWORD}" psql -h "${PGHOST:-db}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" -tAc \
  "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='rei_hiking_routes')")"
REI_COUNT=0
REI_CUTOFF=""
if [[ "${HAS_REI}" == "t" ]]; then
  REI_COUNT="$(PGPASSWORD="${PGPASSWORD}" psql -h "${PGHOST:-db}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" -tAc "SELECT count(*)::bigint FROM rei_hiking_routes")"
  REI_CUTOFF="$(PGPASSWORD="${PGPASSWORD}" psql -h "${PGHOST:-db}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" -tAc "SELECT COALESCE(MAX(updated_at)::text, '') FROM rei_hiking_routes")"
fi

echo "[1/5] regions.geojson ..."
ogr2ogr -f GeoJSON "${OUT}/regions.geojson" "${PG_CONN}" \
  -sql 'SELECT cod_reg, den_reg, geom FROM regions ORDER BY cod_reg' \
  -t_srs EPSG:4326 -lco RFC7946=YES

echo "[2/5] provinces.geojson ..."
ogr2ogr -f GeoJSON "${OUT}/provinces.geojson" "${PG_CONN}" \
  -sql 'SELECT cod_prov, cod_reg, den_prov, sigla, tipo_uts, geom FROM provinces ORDER BY cod_prov' \
  -t_srs EPSG:4326 -lco RFC7946=YES

echo "[3/5] municipalities.geojson (può richiedere diversi minuti) ..."
ogr2ogr -f GeoJSON "${OUT}/municipalities.geojson" "${PG_CONN}" \
  -sql "SELECT
          pro_com,
          pro_com_t,
          comune,
          comune_a,
          cc_uts,
          cod_prov,
          cod_reg,
          popolazione_residente,
          popolazione_istat_anno,
          altitudine_min_sl_m,
          altitudine_max_sl_m,
          altitudine_media_sl_m,
          altitudine_centro_municipio_sl_m,
          altitudine_istat_anno,
          comune_montano_l131,
          sito_web,
          email,
          pec,
          telefono,
          codice_fiscale,
          indirizzo_fisico,
          geom
        FROM municipalities
        ORDER BY pro_com" \
  -t_srs EPSG:4326 -lco RFC7946=YES

if [[ "${HAS_PA}" == "t" ]]; then
  echo "[4/5] protected_areas.geojson (${PA_COUNT} poligoni) ..."
  ogr2ogr -f GeoJSON "${OUT}/protected_areas.geojson" "${PG_CONN}" \
    -sql 'SELECT id, external_code, name, area_type, source_name, geom FROM protected_areas ORDER BY id' \
    -t_srs EPSG:4326 -lco RFC7946=YES
else
  echo "[4/5] protected_areas.geojson — tabella assente, skip."
fi

echo "[5/5] territorial_groups.json ..."
PGPASSWORD="${PGPASSWORD}" psql -h "${PGHOST:-db}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" -t -A -q \
  -c "SELECT json_build_object(
        'groups',
        COALESCE((
          SELECT json_agg(row_to_json(t) ORDER BY t.id)
          FROM (
            SELECT id, slug, label, group_kind, notes,
                   valid_from::text AS valid_from,
                   valid_to::text AS valid_to,
                   source_name,
                   source_url,
                   reference_year,
                   external_id,
                   is_demo
            FROM territorial_groups
          ) t
        ), '[]'::json),
        'members',
        COALESCE((
          SELECT json_agg(row_to_json(m) ORDER BY m.group_id, m.pro_com)
          FROM (
            SELECT group_id, pro_com, joined_at::text AS joined_at
            FROM territorial_group_members
          ) m
        ), '[]'::json)
      )::text" > "${OUT}/territorial_groups.json"

TG_GROUPS_COUNT="$(jq '.groups | length' "${OUT}/territorial_groups.json")"
TG_MEMBERS_COUNT="$(jq '.members | length' "${OUT}/territorial_groups.json")"
TG_REF_MAX="$(PGPASSWORD="${PGPASSWORD}" psql -h "${PGHOST:-db}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" -t -A -q \
  -c 'SELECT COALESCE(MAX(reference_year)::text, '\'''\'' ) FROM territorial_groups')"
BUILD_ID="${NOW}"

# Export sentieri REI e statistiche
if [[ "${HAS_REI}" == "t" ]] && [[ "${REI_COUNT}" -gt 0 ]]; then
  echo "=== rei_hiking_routes.geojson (${REI_COUNT} sentieri) ==="
  PGPASSWORD="${PGPASSWORD}" psql -h "${PGHOST:-db}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" -t -A -q \
    -c "SELECT json_build_object(
          'type', 'FeatureCollection',
          'features', json_agg(
            json_build_object(
              'type', 'Feature',
              'properties', json_build_object(
                'id', id, 'relation_id', relation_id, 'ref', ref, 'ref_rei', ref_rei,
                'name', name, 'sda', sda, 'cai_scale', cai_scale, 'cai_scale_string', cai_scale_string,
                'from_loc', from_loc, 'to_loc', to_loc,
                'city_from', city_from, 'city_from_istat', city_from_istat,
                'region_from', region_from, 'region_from_istat', region_from_istat,
                'city_to', city_to, 'city_to_istat', city_to_istat,
                'region_to', region_to, 'region_to_istat', region_to_istat,
                'distance_km', distance_km, 'ascent_m', ascent_m, 'descent_m', descent_m,
                'ele_min_m', ele_min_m, 'ele_max_m', ele_max_m,
                'ele_from_m', ele_from_m, 'ele_to_m', ele_to_m,
                'duration_forward_min', duration_forward_min, 'duration_backward_min', duration_backward_min,
                'roundtrip', roundtrip, 'abstract', abstract, 'gpx_url', gpx_url,
                'validation_date', validation_date::text, 'survey_date', survey_date::text,
                'osm2cai_status', osm2cai_status, 'source_url', source_url,
                'updated_at', updated_at::text, 'fetched_at', fetched_at::text
              ),
              'geometry', ST_AsGeoJSON(geom)::json
            )
          )
        )::text
        FROM rei_hiking_routes" > "${OUT}/rei_hiking_routes.geojson"

  echo "=== municipality_rei_stats.json ==="
  PGPASSWORD="${PGPASSWORD}" psql -h "${PGHOST:-db}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" -t -A -q \
    -c "SELECT COALESCE(
          (SELECT json_object_agg(pro_com::text,
            json_build_object('km_sda3', km_sda3, 'km_sda4', km_sda4))::text
           FROM (
             SELECT pro_com,
               COALESCE(SUM(km_inside) FILTER (WHERE sda = 3), 0) AS km_sda3,
               COALESCE(SUM(km_inside) FILTER (WHERE sda = 4), 0) AS km_sda4
             FROM municipality_rei_stats GROUP BY pro_com
           ) agg),
          '{}'
        )" > "${OUT}/municipality_rei_stats.json"

  echo "=== protected_area_rei_stats.json ==="
  PGPASSWORD="${PGPASSWORD}" psql -h "${PGHOST:-db}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" -t -A -q \
    -c "SELECT COALESCE(
          (SELECT json_object_agg(protected_area_id::text,
            json_build_object('km_sda3', km_sda3, 'km_sda4', km_sda4))::text
           FROM (
             SELECT protected_area_id,
               COALESCE(SUM(km_inside) FILTER (WHERE sda = 3), 0) AS km_sda3,
               COALESCE(SUM(km_inside) FILTER (WHERE sda = 4), 0) AS km_sda4
             FROM protected_area_rei_stats GROUP BY protected_area_id
           ) agg),
          '{}'
        )" > "${OUT}/protected_area_rei_stats.json"

  echo "=== territorial_group_rei_stats.json ==="
  PGPASSWORD="${PGPASSWORD}" psql -h "${PGHOST:-db}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" -t -A -q \
    -c "SELECT COALESCE(
          (SELECT json_object_agg(group_id::text,
            json_build_object('km_sda3', km_sda3, 'km_sda4', km_sda4))::text
           FROM (
             SELECT group_id,
               COALESCE(SUM(km_inside) FILTER (WHERE sda = 3), 0) AS km_sda3,
               COALESCE(SUM(km_inside) FILTER (WHERE sda = 4), 0) AS km_sda4
             FROM territorial_group_rei_stats GROUP BY group_id
           ) agg),
          '{}'
        )" > "${OUT}/territorial_group_rei_stats.json"
else
  echo "rei_hiking_routes: tabella assente o vuota, skip."
fi

echo "=== manifest.json ==="
(
  cd "${OUT}"
  HASH_REG=$(sha256sum regions.geojson | awk '{print $1}')
  HASH_PROV=$(sha256sum provinces.geojson | awk '{print $1}')
  HASH_COM=$(sha256sum municipalities.geojson | awk '{print $1}')
  HASH_TG=$(sha256sum territorial_groups.json | awk '{print $1}')
  if [[ "${HAS_PA}" == "t" ]] && [[ -f protected_areas.geojson ]]; then
    HASH_PA=$(sha256sum protected_areas.geojson | awk '{print $1}')
  else
    HASH_PA=""
  fi
  if [[ "${HAS_REI}" == "t" ]] && [[ -f rei_hiking_routes.geojson ]]; then
    HASH_REI=$(sha256sum rei_hiking_routes.geojson | awk '{print $1}')
    HASH_MC_STATS=$(sha256sum municipality_rei_stats.json | awk '{print $1}')
    HASH_PA_STATS=$(sha256sum protected_area_rei_stats.json | awk '{print $1}')
    HASH_TG_STATS=$(sha256sum territorial_group_rei_stats.json | awk '{print $1}')
  else
    HASH_REI=""
    HASH_MC_STATS=""
    HASH_PA_STATS=""
    HASH_TG_STATS=""
  fi

  if [[ "${HAS_PA}" == "t" ]]; then JSON_HAS_PA=true; else JSON_HAS_PA=false; fi
  if [[ "${HAS_REI}" == "t" ]] && [[ -n "${HASH_REI}" ]]; then JSON_HAS_REI=true; else JSON_HAS_REI=false; fi

  jq -n \
    --arg schema "comuni-datapack-v1" \
    --argjson version 1 \
    --arg exported_at "${NOW}" \
    --argjson istat_year "${YEAR}" \
    --argjson municipalities_count "${COUNT}" \
    --argjson tg_groups "${TG_GROUPS_COUNT}" \
    --argjson tg_members "${TG_MEMBERS_COUNT}" \
    --arg ref_max "$(printf '%s' "${TG_REF_MAX}" | tr -d '\r\n')" \
    --arg build_id "${BUILD_ID}" \
    --arg hash_regions "${HASH_REG}" \
    --arg hash_provinces "${HASH_PROV}" \
    --arg hash_municipalities "${HASH_COM}" \
    --arg hash_territorial_groups "${HASH_TG}" \
    --argjson has_pa "${JSON_HAS_PA}" \
    --arg hash_protected_areas "${HASH_PA}" \
    --argjson protected_areas_count "${PA_COUNT:-0}" \
    --argjson has_rei "${JSON_HAS_REI}" \
    --argjson rei_count "${REI_COUNT:-0}" \
    --arg rei_cutoff "$(printf '%s' "${REI_CUTOFF:-}" | tr -d '\r\n')" \
    --arg hash_rei "${HASH_REI}" \
    --arg hash_mc_stats "${HASH_MC_STATS}" \
    --arg hash_pa_stats "${HASH_PA_STATS}" \
    --arg hash_tg_stats "${HASH_TG_STATS}" \
    '{
      schema: $schema,
      version: $version,
      exported_at: $exported_at,
      istat_year: $istat_year,
      municipalities_count: $municipalities_count,
      territorial_groups_meta: ({
        schema_version: 1,
        groups_count: $tg_groups,
        members_count: $tg_members,
        build_id: $build_id
      } + (if ($ref_max | length) == 0 then {} else {"reference_year_max": ($ref_max | tonumber)} end)),
      protected_areas_meta: (if $has_pa then { schema_version: 1, areas_count: $protected_areas_count, build_id: $build_id } else null end),
      rei_hiking_routes_meta: (if $has_rei then {
        schema_version: 1,
        routes_count: $rei_count,
        sda: [3, 4],
        source: "osm2cai.cai.it/api/v2",
        cutoff_updated_at: (if ($rei_cutoff | length) == 0 then null else $rei_cutoff end),
        build_id: $build_id
      } else null end),
      files: ({
        regions: { path: "regions.geojson", sha256: $hash_regions },
        provinces: { path: "provinces.geojson", sha256: $hash_provinces },
        municipalities: { path: "municipalities.geojson", sha256: $hash_municipalities },
        territorial_groups: { path: "territorial_groups.json", sha256: $hash_territorial_groups }
      }
      + (if $has_pa and ($hash_protected_areas | length) > 0 then { protected_areas: { path: "protected_areas.geojson", sha256: $hash_protected_areas } } else {} end)
      + (if $has_rei and ($hash_rei | length) > 0 then {
          rei_hiking_routes: { path: "rei_hiking_routes.geojson", sha256: $hash_rei },
          municipality_rei_stats: { path: "municipality_rei_stats.json", sha256: $hash_mc_stats },
          protected_area_rei_stats: { path: "protected_area_rei_stats.json", sha256: $hash_pa_stats },
          territorial_group_rei_stats: { path: "territorial_group_rei_stats.json", sha256: $hash_tg_stats }
        } else {} end))
    }' > manifest.json
)

echo "OK: datapack scritto in ${OUT}"

if [[ "${CREATE_ZIP:-0}" == "1" ]]; then
  ZIP_NAME="${ZIP_NAME:-comuni-datapack-${YEAR}.zip}"
  echo "ZIP dentro ${OUT}: ${ZIP_NAME}"
  (
    cd "${OUT}"
    rm -f "${ZIP_NAME}"
    ZIPFILES=(manifest.json regions.geojson provinces.geojson municipalities.geojson territorial_groups.json)
    if [[ -f protected_areas.geojson ]]; then ZIPFILES+=(protected_areas.geojson); fi
    if [[ -f rei_hiking_routes.geojson ]]; then
      ZIPFILES+=(rei_hiking_routes.geojson municipality_rei_stats.json protected_area_rei_stats.json territorial_group_rei_stats.json)
    fi
    zip -rq "${ZIP_NAME}" "${ZIPFILES[@]}"
  )
fi
