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

# Le immagini devono includere gli ultimi script (evita cache vecchie).
docker compose build loader api

docker compose up -d db api >/dev/null

until docker compose exec -T db pg_isready -U postgres -d comuni >/dev/null 2>&1; do
  sleep 2
done

docker compose run --rm loader bash load.sh --force

echo "=== Import raggruppamenti nazionali (città metropolitane) ==="
docker compose exec -T api node scripts/import_italy_metropolitan_cities.js

if [[ -f "${ROOT_DIR}/data/toscana-unioni-2024-01-01.csv" ]]; then
  echo "=== Import Toscana (unioni) da CSV locale ==="
  docker compose run --rm \
    -v "${ROOT_DIR}/data:/data:ro" \
    api node scripts/import_toscana_unioni.js --file /data/toscana-unioni-2024-01-01.csv
else
  echo "=== Skip import Toscana: CSV locale non trovato in data/ ==="
fi

docker compose run --rm \
  -e DATAPACK_DIR=/datapack \
  -e ISTAT_YEAR="${ISTAT_YEAR:-}" \
  -e CREATE_ZIP="${CREATE_ZIP:-0}" \
  -e ZIP_NAME="${ZIP_NAME:-}" \
  -v "${OUT}:/datapack" \
  loader bash /loader/export_datapack.sh

echo "OK."
