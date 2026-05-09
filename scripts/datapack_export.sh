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

echo "=== Esport datapack da DB corrente → ${OUT} ==="
docker compose build loader
docker compose up -d db >/dev/null
docker compose run --rm \
  -e DATAPACK_DIR=/datapack \
  -e ISTAT_YEAR="${ISTAT_YEAR:-}" \
  -e CREATE_ZIP="${CREATE_ZIP:-0}" \
  -e ZIP_NAME="${ZIP_NAME:-}" \
  -v "${OUT}:/datapack" \
  loader bash /loader/export_datapack.sh

echo "OK."
