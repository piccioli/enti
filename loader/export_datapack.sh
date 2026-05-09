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

echo "[1/4] regions.geojson ..."
ogr2ogr -f GeoJSON "${OUT}/regions.geojson" "${PG_CONN}" \
  -sql 'SELECT cod_reg, den_reg, geom FROM regions ORDER BY cod_reg' \
  -t_srs EPSG:4326 -lco RFC7946=YES

echo "[2/4] provinces.geojson ..."
ogr2ogr -f GeoJSON "${OUT}/provinces.geojson" "${PG_CONN}" \
  -sql 'SELECT cod_prov, cod_reg, den_prov, sigla, tipo_uts, geom FROM provinces ORDER BY cod_prov' \
  -t_srs EPSG:4326 -lco RFC7946=YES

echo "[3/4] municipalities.geojson (può richiedere diversi minuti) ..."
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

echo "[4/4] territorial_groups.json ..."
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

echo "=== manifest.json ==="
(
  cd "${OUT}"
  HASH_REG=$(sha256sum regions.geojson | awk '{print $1}')
  HASH_PROV=$(sha256sum provinces.geojson | awk '{print $1}')
  HASH_COM=$(sha256sum municipalities.geojson | awk '{print $1}')
  HASH_TG=$(sha256sum territorial_groups.json | awk '{print $1}')

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
      files: {
        regions: { path: "regions.geojson", sha256: $hash_regions },
        provinces: { path: "provinces.geojson", sha256: $hash_provinces },
        municipalities: { path: "municipalities.geojson", sha256: $hash_municipalities },
        territorial_groups: { path: "territorial_groups.json", sha256: $hash_territorial_groups }
      }
    }' > manifest.json
)

echo "OK: datapack scritto in ${OUT}"

if [[ "${CREATE_ZIP:-0}" == "1" ]]; then
  ZIP_NAME="${ZIP_NAME:-comuni-datapack-${YEAR}.zip}"
  echo "ZIP dentro ${OUT}: ${ZIP_NAME}"
  (
    cd "${OUT}"
    rm -f "${ZIP_NAME}"
    zip -rq "${ZIP_NAME}" \
      manifest.json regions.geojson provinces.geojson municipalities.geojson territorial_groups.json
  )
fi
