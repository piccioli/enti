#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
YEAR="${ISTAT_YEAR:-2026}"
ZIP_URL="https://www.istat.it/storage/cartografia/confini_amministrativi/generalizzati/${YEAR}/Limiti0101${YEAR}_g.zip"
WORKDIR="/tmp/istat_${YEAR}"

PG_CONN="PG:host=${PGHOST} port=${PGPORT:-5432} dbname=${PGDATABASE} user=${PGUSER} password=${PGPASSWORD}"

echo "=== ISTAT Comuni Loader - year ${YEAR} ==="

# Idempotency check
COUNT=$(PGPASSWORD="${PGPASSWORD}" psql -h "${PGHOST}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" \
  -tAc "SELECT count(*) FROM municipalities" 2>/dev/null || echo "0")

if [ "${COUNT}" -gt "0" ] && [ "${1:-}" != "--force" ]; then
  echo "Already loaded ${COUNT} municipalities. Skipping (pass --force to reload boundaries and ISTAT demographics)."
  exit 0
fi

mkdir -p "${WORKDIR}"
cd "${WORKDIR}"

echo "Downloading: ${ZIP_URL}"
if [ "${CURL_INSECURE:-}" = "1" ]; then
  echo "(CURL_INSECURE=1: certificate verification disabled for this download)"
  curl -fsSLk "${ZIP_URL}" -o limiti.zip
else
  curl -fsSL "${ZIP_URL}" -o limiti.zip
fi
echo "Extracting..."
unzip -o limiti.zip

# Locate shapefiles
REG_SHP=$(find . -name "Reg*_WGS84.shp" | head -1)
PROV_SHP=$(find . -name "ProvCM*_WGS84.shp" | head -1)
COM_SHP=$(find . -name "Com*_WGS84.shp" | head -1)

REG_LAYER=$(basename "${REG_SHP}" .shp)
PROV_LAYER=$(basename "${PROV_SHP}" .shp)
COM_LAYER=$(basename "${COM_SHP}" .shp)

echo "Found layers: ${REG_LAYER}, ${PROV_LAYER}, ${COM_LAYER}"

echo "Loading regions..."
ogr2ogr -f "PostgreSQL" "${PG_CONN}" "${REG_SHP}" \
  -sql "SELECT COD_REG, DEN_REG FROM \"${REG_LAYER}\"" \
  -nln regions \
  -t_srs EPSG:4326 \
  -nlt PROMOTE_TO_MULTI \
  -lco GEOMETRY_NAME=geom \
  -overwrite

echo "Loading provinces..."
ogr2ogr -f "PostgreSQL" "${PG_CONN}" "${PROV_SHP}" \
  -sql "SELECT COD_PROV, COD_REG, DEN_UTS as den_prov, SIGLA, TIPO_UTS FROM \"${PROV_LAYER}\"" \
  -nln provinces \
  -t_srs EPSG:4326 \
  -nlt PROMOTE_TO_MULTI \
  -lco GEOMETRY_NAME=geom \
  -overwrite

echo "Loading municipalities..."
ogr2ogr -f "PostgreSQL" "${PG_CONN}" "${COM_SHP}" \
  -sql "SELECT PRO_COM, PRO_COM_T, COD_PROV, COD_REG, COMUNE, COMUNE_A, CC_UTS FROM \"${COM_LAYER}\"" \
  -nln municipalities \
  -t_srs EPSG:4326 \
  -nlt PROMOTE_TO_MULTI \
  -lco GEOMETRY_NAME=geom \
  -overwrite

echo "Running post-load SQL (constraints + indexes)..."
PGPASSWORD="${PGPASSWORD}" psql -h "${PGHOST}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" \
  -f /loader/post_load.sql

if [ "${SKIP_ISTAT_POP:-0}" != "1" ]; then
  # shellcheck disable=SC1091
  source "${SCRIPT_DIR}/load_popolazione.sh"
  load_popolazione_main || {
    echo "ERROR: Population import failed." >&2
    exit 1
  }
else
  echo "SKIP_ISTAT_POP=1: skipping ISTAT demographic POS import."
fi

if [ "${SKIP_ISTAT_ALTIMETRIA:-0}" != "1" ]; then
  # shellcheck disable=SC1091
  source "${SCRIPT_DIR}/load_altimetria.sh"
  load_altimetria_main || {
    echo "ERROR: Altimetria import failed." >&2
    exit 1
  }
else
  echo "SKIP_ISTAT_ALTIMETRIA=1: skipping ISTAT altimetria (DEM)."
fi

if [ "${SKIP_COMUNI_MONTANI_L131:-0}" != "1" ]; then
  # shellcheck disable=SC1091
  source "${SCRIPT_DIR}/load_comuni_montani_l131.sh"
  load_comuni_montani_l131_main || {
    echo "ERROR: Comuni montani L.131 import failed." >&2
    exit 1
  }
else
  echo "SKIP_COMUNI_MONTANI_L131=1: skipping comuni montani (L. 131) PDF import."
fi

if [ "${SKIP_COMUNI_CONTATTI:-0}" != "1" ]; then
  # shellcheck disable=SC1091
  source "${SCRIPT_DIR}/load_contatti_comuni.sh"
  load_contatti_comuni_main || {
    echo "ERROR: Comuni contatti import failed." >&2
    exit 1
  }
else
  echo "SKIP_COMUNI_CONTATTI=1: skipping comuni contacts CSV import."
fi

FINAL=$(PGPASSWORD="${PGPASSWORD}" psql -h "${PGHOST}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" \
  -tAc "SELECT count(*) FROM municipalities")

echo "=== Done! Loaded ${FINAL} municipalities ==="
