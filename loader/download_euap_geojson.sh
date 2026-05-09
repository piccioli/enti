#!/usr/bin/env bash
# Scarica l'EUAP (Elenco ufficiale aree naturali protette) da ISPRA SINA Cloud
# (servizio ArcGIS FeatureServer del Ministero/ISPRA) in GeoJSON RFC7946.
#
# Fonte predefinita: layer "euap" — Hosted/euap_mattm/FeatureServer/0
# Metadati / condizioni di riuso: verificare su geoportale MASE / scheda dataset ISPRA (tipicamente open data).
#
# Uso:
#   download_euap_geojson.sh /data/protected_areas.geojson
#
# Variabili:
#   EUAP_ARCGIS_LAYER_URL  Base fino a .../FeatureServer/0 (senza /query)
#   EUAP_PAGE_SIZE         Record per richiesta (default 2000, max del servizio)
#
set -euo pipefail

OUT="${1:?path output .geojson}"

LAYER_BASE="${EUAP_ARCGIS_LAYER_URL:-https://sinacloud.isprambiente.it/arcgisadv/rest/services/Hosted/euap_mattm/FeatureServer/0}"
PAGE="${EUAP_PAGE_SIZE:-2000}"

# Campi attesi dal layer EUAP ISPRA (nome, codice EUAP, tipologia)
OUT_FIELDS="nome_gazze,codice_are,tipo,id"

TMPDIR="$(mktemp -d "${TMPDIR:-/tmp}/euap_dl.XXXXXX")"
cleanup() { rm -rf "${TMPDIR}" || true; }
trap cleanup EXIT

echo "=== Download EUAP da ISPRA (layer: ${LAYER_BASE}) ==="

COUNT_JSON="$(curl -fsSL "${LAYER_BASE}/query?where=1%3D1&returnCountOnly=true&f=json")"
TOTAL="$(echo "${COUNT_JSON}" | jq -r '.count // 0')"
echo "Record totali (servizio): ${TOTAL}"

OFFSET=0
PAGE_IDX=0
while true; do
  QUERY="${LAYER_BASE}/query?where=1%3D1&outFields=${OUT_FIELDS}&returnGeometry=true&outSR=4326&f=geojson&resultOffset=${OFFSET}&resultRecordCount=${PAGE}"
  OUT_PAGE="${TMPDIR}/p${PAGE_IDX}.json"
  curl -fsSL "${QUERY}" -o "${OUT_PAGE}"

  N="$(jq '.features | length' "${OUT_PAGE}")"
  if [[ "${N}" -eq 0 ]]; then
    break
  fi

  echo "  Scaricati offset ${OFFSET}: ${N} geometrie"
  OFFSET=$((OFFSET + N))
  PAGE_IDX=$((PAGE_IDX + 1))

  EXCEEDED="$(jq -r '.properties.exceededTransferLimit // false' "${OUT_PAGE}")"
  if [[ "${EXCEEDED}" != "true" ]] || [[ "${N}" -lt "${PAGE}" ]]; then
    break
  fi
done

if [[ "${PAGE_IDX}" -eq 0 ]]; then
  echo "ERROR: nessun feature scaricato." >&2
  exit 1
fi

jq -s '{ type: "FeatureCollection", features: [.[].features[]] }' "${TMPDIR}"/p*.json > "${OUT}"
echo "OK: scritto ${OUT} ($(jq '.features | length' "${OUT}") features)"
