#!/usr/bin/env bash
# Scarica foglio Altimetria comuni ISTAT (XLSX), converte con parse_altimetria_xlsx.py, aggiorna municipalities.

SCRIPT_DIR="${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"

load_altimetria_main() {
  local CURL_ARGS=("-fsSL" "-A" "Mozilla/5.0 (WEBMAPP municipalities loader)")
  local xls_url="${ISTAT_ALTIMETRIA_XLS_URL:-https://www.istat.it/wp-content/uploads/2026/02/Altimetria_Comuni-al-31_12_2021.xlsx}"

  if [ "${CURL_INSECURE:-}" = "1" ]; then
    CURL_ARGS=("-fsSLk" "-A" "Mozilla/5.0 (WEBMAPP municipalities loader)")
    echo "(CURL_INSECURE=1: certificate verification disabled for altimetria download)"
  fi

  local workdir="${WORKDIR_ALTI:-/tmp/istat_altimetria}"
  mkdir -p "${workdir}"
  local xlsx="${workdir}/Altimetria_Comuni.xlsx"
  local csv="${workdir}/altimetria.csv"

  echo "Downloading ISTAT altimetria: ${xls_url}"
  curl "${CURL_ARGS[@]}" "${xls_url}" -o "${xlsx}"

  echo "Converting XLSX → CSV..."
  python3 "${SCRIPT_DIR}/parse_altimetria_xlsx.py" "${xlsx}" > "${csv}" 2>"${workdir}/parse.log"
  if [ ! -s "${csv}" ]; then
    echo "ERROR: CSV altimetria vuoto o parser fallito." >&2
    cat "${workdir}/parse.log" >&2 || true
    return 1
  fi
  local lines
  lines=$(wc -l < "${csv}" | tr -d ' ')
  echo "Altimetria rows (incl. header): ${lines}. $(grep wrote_rows "${workdir}/parse.log" || true)"

  echo "Ensuring altimetria columns on municipalities..."
  PGPASSWORD="${PGPASSWORD}" psql -h "${PGHOST}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" \
    -v ON_ERROR_STOP=1 <<'EOSQL'
ALTER TABLE municipalities
  ADD COLUMN IF NOT EXISTS altitudine_min_sl_m INTEGER,
  ADD COLUMN IF NOT EXISTS altitudine_max_sl_m INTEGER,
  ADD COLUMN IF NOT EXISTS altitudine_media_sl_m NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS altitudine_centro_municipio_sl_m INTEGER,
  ADD COLUMN IF NOT EXISTS altitudine_istat_anno SMALLINT;
EOSQL

  echo "Loading altimetria into municipalities..."
  PGPASSWORD="${PGPASSWORD}" psql -h "${PGHOST}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" \
    -v ON_ERROR_STOP=1 <<EOSQL
BEGIN;
CREATE TEMP TABLE _alti (
  pro_com INTEGER,
  alt_min INTEGER,
  alt_max INTEGER,
  alt_media NUMERIC(12,4),
  alt_centro INTEGER
);

\copy _alti FROM '${csv}' WITH (FORMAT CSV, HEADER true, NULL '')

UPDATE municipalities AS m
SET
  altitudine_min_sl_m = a.alt_min,
  altitudine_max_sl_m = a.alt_max,
  altitudine_media_sl_m = a.alt_media::numeric,
  altitudine_centro_municipio_sl_m = a.alt_centro,
  altitudine_istat_anno = 2021
FROM _alti AS a
WHERE CAST(m.pro_com AS integer) = a.pro_com;

COMMIT;
EOSQL

  local nupd
  nupd=$(PGPASSWORD="${PGPASSWORD}" psql -h "${PGHOST}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" \
    -tAc "SELECT count(*) FROM municipalities WHERE altitudine_media_sl_m IS NOT NULL;")

  echo "Updated altimetria for ${nupd} municipalities."
  rm -f "${csv}" "${xlsx}" "${workdir}/parse.log"
}
