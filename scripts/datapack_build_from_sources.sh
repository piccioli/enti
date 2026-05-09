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

# L'immagine loader deve includere export_datapack.sh (se vedi "No such file" era una build vecchia in cache).
docker compose build loader

docker compose up -d db >/dev/null

until docker compose exec -T db pg_isready -U postgres -d comuni >/dev/null 2>&1; do
  sleep 2
done

docker compose run --rm loader bash load.sh --force

docker compose run --rm \
  -e DATAPACK_DIR=/datapack \
  -e ISTAT_YEAR="${ISTAT_YEAR:-}" \
  -e CREATE_ZIP="${CREATE_ZIP:-0}" \
  -e ZIP_NAME="${ZIP_NAME:-}" \
  -v "${OUT}:/datapack" \
  loader bash /loader/export_datapack.sh

echo "OK."
