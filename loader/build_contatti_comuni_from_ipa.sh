#!/usr/bin/env bash
# Scarica open data IPA e genera un CSV in formato importabile dal loader.
#
# Output default: /data/contatti-comuni.csv (cartella montata dal progetto ./data)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${IPA_CONTATTI_OUT:-/data/contatti-comuni.csv}"

echo "Building contatti-comuni CSV from IPA → ${OUT}"
python3 "${SCRIPT_DIR}/build_contatti_comuni_from_ipa.py" "${OUT}"
echo "Done. Rows (incl header): $(wc -l < "${OUT}" | tr -d ' ')"

