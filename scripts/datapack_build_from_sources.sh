#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: comando 'docker compose' non disponibile." >&2
  exit 1
fi

OUT="${DATAPACK_DIR:-./datapack-dist}"
if [[ "${OUT}" != /* ]]; then
  OUT="${ROOT_DIR}/${OUT#./}"
fi
mkdir -p "${OUT}"

echo "=== Ricostruzione datapack dagli scrape ISTAT (load.sh --force in container) → ${OUT} ==="

# Workspace temporaneo per sorgenti/artefatti di build (evita dipendenza da ./data).
TMP_DATA="$(mktemp -d "${TMPDIR:-/tmp}/wm-municipalities-data.XXXXXX")"
cleanup() {
  rm -rf "${TMP_DATA}" || true
}
trap cleanup EXIT

# Le immagini devono includere gli ultimi script (evita cache vecchie).
docker compose build loader api

docker compose up -d db api >/dev/null

until docker compose exec -T db pg_isready -U postgres -d comuni >/dev/null 2>&1; do
  sleep 2
done

echo "=== Build contatti comuni (IPA) → /data/contatti-comuni.csv (opzionale) ==="
docker compose run --rm \
  -v "${TMP_DATA}:/data" \
  loader bash -lc 'bash /loader/build_contatti_comuni_from_ipa.sh || echo "WARN: contatti comuni non generati (ok se vuoi SKIP_COMUNI_CONTATTI=1 o rete non disponibile)"'

docker compose run --rm \
  -v "${TMP_DATA}:/data" \
  loader bash load.sh --force

echo "=== Import raggruppamenti nazionali (città metropolitane) ==="
docker compose exec -T api node scripts/import_italy_metropolitan_cities.js

echo "=== Download + import unioni/comunità montane (Italia, ANCI 2023) ==="
ANCI_UNIONI_PDF_URL="https://www.anci.it/wp-content/uploads/Elenco-Unioni-di-Comuni-anno-2023.pdf"

# Conversione PDF->TXT nel container loader (poppler-utils già presente nell'immagine).
docker compose run --rm \
  -v "${TMP_DATA}:/data" \
  loader bash -lc \
  "set -euo pipefail; \
   echo 'Downloading: ${ANCI_UNIONI_PDF_URL}'; \
   curl -L '${ANCI_UNIONI_PDF_URL}' -o /data/anci-unioni-2023.pdf; \
   pdftotext /data/anci-unioni-2023.pdf /data/anci-unioni-2023.txt"

docker compose run --rm \
  -v "${TMP_DATA}:/data:ro" \
  api node scripts/import_italy_unioni_anci_2023.js --format columns --file /data/anci-unioni-2023.txt

docker compose run --rm \
  -e DATAPACK_DIR=/datapack \
  -e ISTAT_YEAR="${ISTAT_YEAR:-}" \
  -e CREATE_ZIP="${CREATE_ZIP:-0}" \
  -e ZIP_NAME="${ZIP_NAME:-}" \
  -v "${OUT}:/datapack" \
  loader bash /loader/export_datapack.sh

echo "OK."
