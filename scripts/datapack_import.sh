#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: comando richiesto non trovato: $1" >&2
    exit 1
  }
}

# Dopo unzip: manifest alla radice o in un'unica sottocartella.
find_manifest_dir() {
  local root="$1"
  if [[ -f "${root}/manifest.json" ]]; then
    printf '%s' "${root}"
    return 0
  fi
  local found=""
  local d
  shopt -s nullglob
  for d in "${root}"/*/; do
    [[ -d "$d" ]] || continue
    if [[ -f "${d}manifest.json" ]]; then
      if [[ -n "${found}" ]]; then
        echo "ERROR: più cartelle con manifest.json sotto ${root}; archivio o struttura non univoca." >&2
        shopt -u nullglob
        return 1
      fi
      found="$d"
    fi
  done
  shopt -u nullglob
  if [[ -n "${found}" ]]; then
    printf '%s' "${found}"
    return 0
  fi
  echo "ERROR: manifest.json non trovato dopo unzip (atteso in radice o in un'unica sottocartella)." >&2
  return 1
}

is_zip_file() {
  local p="$1"
  [[ -f "$p" ]] || return 1
  local pl
  pl="$(printf '%s' "$p" | tr '[:upper:]' '[:lower:]')"
  case "$pl" in
    *.zip) return 0 ;;
    *) return 1 ;;
  esac
}

# Default: ./datapack-dist (relativo alla root del progetto)
ARG="${1:-./datapack-dist}"
if [[ "${ARG}" != /* ]]; then
  ARG="${ROOT_DIR}/${ARG#./}"
fi

CLEANUP_TMP=""

cleanup() {
  if [[ -n "${CLEANUP_TMP}" && -d "${CLEANUP_TMP}" ]]; then
    rm -rf "${CLEANUP_TMP}"
  fi
}
trap cleanup EXIT

DATAPACK_HOST=""

if [[ -f "${ARG}" ]] && is_zip_file "${ARG}"; then
  need_cmd unzip
  CLEANUP_TMP="$(mktemp -d)"
  echo "=== Unzip ${ARG} → ${CLEANUP_TMP} ==="
  unzip -q -o "${ARG}" -d "${CLEANUP_TMP}"
  DATAPACK_HOST="$(find_manifest_dir "${CLEANUP_TMP}")" || exit 1

elif [[ -d "${ARG}" ]]; then
  if [[ -f "${ARG}/manifest.json" ]]; then
    DATAPACK_HOST="${ARG}"
  else
    shopt -s nullglob
    local_zips=( "${ARG}"/*.[zZ][iI][pP] )
    shopt -u nullglob
    if [[ ${#local_zips[@]} -eq 1 ]]; then
      need_cmd unzip
      CLEANUP_TMP="$(mktemp -d)"
      echo "=== Cartella senza manifest: unzip $(basename "${local_zips[0]}") → ${CLEANUP_TMP} ==="
      unzip -q -o "${local_zips[0]}" -d "${CLEANUP_TMP}"
      DATAPACK_HOST="$(find_manifest_dir "${CLEANUP_TMP}")" || exit 1
    elif [[ ${#local_zips[@]} -gt 1 ]]; then
      echo "USAGE: $(basename "$0") /percorso/file.zip   oppure   cartella con un solo .zip e manifest assente" >&2
      echo "ERROR: più file .zip in ${ARG}: indica il file .zip da usare." >&2
      exit 1
    else
      echo "USAGE: $(basename "$0") /percorso/datapack   |   /percorso/comuni-datapack-YYYY.zip" >&2
      echo "(serve manifest.json nella cartella, oppure un solo .zip da estrarre)" >&2
      exit 1
    fi
  fi

else
  echo "ERROR: percorso non trovato: ${ARG}" >&2
  echo "USAGE: $(basename "$0") [/percorso/cartella_o_file.zip]" >&2
  exit 1
fi

if [[ ! -f "${DATAPACK_HOST}/manifest.json" ]]; then
  echo "ERROR: manifest.json mancante in ${DATAPACK_HOST}" >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: comando 'docker compose' non disponibile." >&2
  exit 1
fi

echo "=== Import datapack (${DATAPACK_HOST}) sul container DB ==="
docker compose build loader
docker compose up -d db >/dev/null
docker compose run --rm \
  -v "${DATAPACK_HOST}:/datapack:ro" \
  loader bash /loader/import_datapack.sh

echo "OK. Riavvio api/web consigliato: docker compose up -d --build api web"
