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

echo "=== Ricostruzione datapack dagli scrape ISTAT (load.sh --force in container) ==="
echo "    Directory output (host): ${OUT}"

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

echo "=== Verifica tabella municipalities (obbligatoria per export) ==="
COMUNI_COUNT="$(docker compose exec -T db psql -U postgres -d comuni -tAc "SELECT count(*) FROM municipalities" | tr -d '[:space:]')"
if [[ -z "${COMUNI_COUNT}" || "${COMUNI_COUNT}" == "0" ]]; then
  echo "ERROR: dopo load.sh il database non contiene comuni (municipalities vuota)." >&2
  echo "       L'export datapack non può proseguire. Controlla sopra gli errori del loader (rete, ISTAT, SSL)." >&2
  echo "       Ripeti solo il caricamento: docker compose run --rm -v \"\$(mktemp -d):/data\" loader bash load.sh --force" >&2
  exit 1
fi
echo "OK: ${COMUNI_COUNT} comuni importati nel DB."

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

echo "=== Migrazione DB aree protette (013) ==="
docker compose exec -T db psql -U postgres -d comuni -v ON_ERROR_STOP=1 < "${ROOT_DIR}/db/migrations/013_protected_areas.sql"

echo "=== Import aree protette (EUAP ISPRA / GeoJSON custom) ==="
if [[ "${SKIP_PROTECTED_AREAS:-0}" == "1" ]]; then
  echo "SKIP_PROTECTED_AREAS=1: import aree protette saltato."
else
  # Predefinito: EUAP da ISPRA SINA Cloud (FeatureServer). Override: PROTECTED_AREAS_URL o file già in /data.
  if [[ -n "${PROTECTED_AREAS_URL:-}" ]]; then
    echo "Download GeoJSON custom: ${PROTECTED_AREAS_URL}"
    curl -fsSL "${PROTECTED_AREAS_URL}" -o "${TMP_DATA}/protected_areas.geojson"
  elif [[ ! -f "${TMP_DATA}/protected_areas.geojson" ]]; then
    echo "Download EUAP (ISPRA SINA Cloud, FeatureServer euap_mattm) → protected_areas.geojson"
    docker compose run --rm \
      -v "${TMP_DATA}:/data" \
      -e EUAP_ARCGIS_LAYER_URL="${EUAP_ARCGIS_LAYER_URL:-}" \
      -e EUAP_PAGE_SIZE="${EUAP_PAGE_SIZE:-}" \
      loader bash /loader/download_euap_geojson.sh /data/protected_areas.geojson
  else
    echo "Uso protected_areas.geojson già presente in workspace build."
  fi
  docker compose run --rm \
    -v "${TMP_DATA}:/data" \
    -e SKIP_PROTECTED_AREAS="${SKIP_PROTECTED_AREAS:-0}" \
    -e PROTECTED_AREAS_PATH="${PROTECTED_AREAS_PATH:-/data/protected_areas.geojson}" \
    -e PA_SOURCE_NAME="${PA_SOURCE_NAME:-ISPRA_SINA_EUAP}" \
    -e PA_NAME_KEYS="${PA_NAME_KEYS:-nome_gazze,name,NOME,DENOMINAZIONE}" \
    -e PA_CODE_KEYS="${PA_CODE_KEYS:-codice_are,code,CODICE,id,ID}" \
    -e PA_TYPE_KEYS="${PA_TYPE_KEYS:-tipo,type,TIPO,TIPOLOGIA}" \
    api node scripts/import_protected_areas.js
fi

echo "=== Migrazione DB sentieri REI (014) ==="
docker compose exec -T db psql -U postgres -d comuni -v ON_ERROR_STOP=1 < "${ROOT_DIR}/db/migrations/014_rei_hiking_routes.sql"

echo "=== Import sentieri REI da ${OUT}/sentieri (o sentier): GeoJSON precaricati, nessun download ==="
if [[ "${SKIP_REI:-0}" == "1" ]]; then
  echo "SKIP_REI=1: import sentieri REI saltato."
else
  mkdir -p "${OUT}/sentieri" "${OUT}/sentier"
  docker compose run --rm \
    -v "${OUT}:/datapack" \
    -e DATAPACK_DIR=/datapack \
    api node scripts/import_rei_sentier.js
fi

docker compose run --rm \
  -e DATAPACK_DIR=/datapack \
  -e ISTAT_YEAR="${ISTAT_YEAR:-}" \
  -e CREATE_ZIP="${CREATE_ZIP:-0}" \
  -e ZIP_NAME="${ZIP_NAME:-}" \
  -v "${OUT}:/datapack" \
  loader bash /loader/export_datapack.sh

echo "OK. File datapack in:"
ls -la "${OUT}"
echo "(Percorso assoluto: ${OUT})"
