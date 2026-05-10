#!/usr/bin/env bash
# Deploy stack (docker compose build + up). In chat progetto «fr» = lanciare questo script.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: comando 'docker compose' non disponibile." >&2
  exit 1
fi

IMPORT_DIR=""
if [[ "${1:-}" == "--import-datapack" ]]; then
  # Default come datapack_import.sh: ./datapack-dist
  IMPORT_DIR="${2:-./datapack-dist}"
fi

docker compose up -d --build

if [[ -n "${IMPORT_DIR}" ]]; then
  # Stessa logica di datapack_import.sh (cartella, .zip, cartella con un solo zip)
  bash "${ROOT_DIR}/scripts/datapack_import.sh" "${IMPORT_DIR}"
fi

echo "Servizi avviati. Endpoint locale tipico (vedi WEB_PORT nel .env): http://127.0.0.1:8080/"
