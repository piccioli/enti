#!/usr/bin/env bash
# Diagnostic: confronta elenco PDF comuni montani con municipalities (casismi apostrofi, hyphen, unmatched).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${WORKDIR_MONTANI_CHECK:-/tmp/mchk_$$}"

mkdir -p "${WORK}"
cleanup() { rm -rf "${WORK}"; }
trap cleanup EXIT

PDF_URL="${COMUNI_MONTANI_L131_PDF_URL:-https://www.biblus.accademiafirenze.it/wp-content/uploads/2026/02/comuni-montani-elenco-febbraio-2026.pdf}"

if [ -n "${COMUNI_MONTANI_L131_PDF:-}" ] && [ -f "${COMUNI_MONTANI_L131_PDF}" ]; then
  echo "Using local PDF: ${COMUNI_MONTANI_L131_PDF}"
  cp -f "${COMUNI_MONTANI_L131_PDF}" "${WORK}/source.pdf"
else
  echo "Downloading: ${PDF_URL}"
  CURL_ARGS=("-fsSL" "-L")
  if [ "${CURL_INSECURE:-}" = "1" ]; then CURL_ARGS=("-fsSLk" "-L"); fi
  curl "${CURL_ARGS[@]}" "${PDF_URL}" -o "${WORK}/source.pdf"
fi

pdftohtml -q -xml -hidden -nodrm -i "${WORK}/source.pdf" "${WORK}/out"
python3 "${SCRIPT_DIR}/parse_comuni_montani_pdf_xml.py" "${WORK}/out.xml" > "${WORK}/montani.csv"
ROWS=$(($(wc -l < "${WORK}/montani.csv") - 1))
echo "Parsed PDF rows (unique sigla,comune): ${ROWS}"

cp -f "${WORK}/montani.csv" /tmp/montani.csv
PGPASSWORD="${PGPASSWORD:-}" psql -h "${PGHOST:-db}" -p "${PGPORT:-5432}" -U "${PGUSER:-postgres}" -d "${PGDATABASE:-comuni}" \
  -v ON_ERROR_STOP=1 \
  -f "${SCRIPT_DIR}/check_montani_difficult.sql"
