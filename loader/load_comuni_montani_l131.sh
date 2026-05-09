#!/usr/bin/env bash
# Elenco PDF «comuni montani» L. 131/2025: pdftohtml -xml → parse → aggiorna municipalities.

SCRIPT_DIR="${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"

load_comuni_montani_l131_main() {
  if [ "${SKIP_COMUNI_MONTANI_L131:-0}" = "1" ]; then
    echo "SKIP_COMUNI_MONTANI_L131=1: skipping comuni montani (L. 131)."
    return 0
  fi

  local CURL_ARGS=("-fsSL" "-L" "-A" "Mozilla/5.0 (WEBMAPP municipalities loader)")
  local workdir="${WORKDIR_MONTANI_L131:-/tmp/comuni_montani_l131}"
  mkdir -p "${workdir}"
  local pdf="${workdir}/comuni-montani-l131.pdf"
  local xmlp="${workdir}/montani_pdftohtml.xml"
  local csv="${workdir}/montani.csv"

  if [ "${CURL_INSECURE:-}" = "1" ]; then
    CURL_ARGS=("-fsSLk" "-L" "-A" "Mozilla/5.0 (WEBMAPP municipalities loader)")
    echo "(CURL_INSECURE=1: certificate verification disabled for comuni montani PDF download)"
  fi

  if [ -n "${COMUNI_MONTANI_L131_PDF:-}" ] && [ -f "${COMUNI_MONTANI_L131_PDF}" ]; then
    echo "Using local PDF: ${COMUNI_MONTANI_L131_PDF}"
    cp -f "${COMUNI_MONTANI_L131_PDF}" "${pdf}"
  else
    local url="${COMUNI_MONTANI_L131_PDF_URL:-https://www.affariregionali.it/media/koydmoxc/comuni-montani-elenco-feb-2026.pdf}"
    echo "Downloading comuni montani PDF: ${url}"
    curl "${CURL_ARGS[@]}" "${url}" -o "${pdf}"
  fi

  if [ ! -s "${pdf}" ]; then
    echo "ERROR: PDF vuoto o mancante." >&2
    return 1
  fi

  echo "Converting PDF → XML (poppler pdftohtml)..."
  rm -f "${xmlp}"
  pdftohtml -q -xml -hidden -nodrm -i "${pdf}" "${workdir}/m"
  if [ -f "${workdir}/m.xml" ]; then
    mv -f "${workdir}/m.xml" "${xmlp}"
  else
    echo "ERROR: pdftohtml non ha prodotto m.xml in ${workdir}" >&2
    return 1
  fi

  echo "Parsing XML → CSV..."
  python3 "${SCRIPT_DIR}/parse_comuni_montani_pdf_xml.py" "${xmlp}" > "${csv}" 2>"${workdir}/parse.log"
  if [ ! -s "${csv}" ]; then
    echo "ERROR: CSV comuni montani vuoto." >&2
    cat "${workdir}/parse.log" >&2 || true
    return 1
  fi
  grep wrote_unique_rows "${workdir}/parse.log" || true

  echo "Ensuring L.131 columns on municipalities..."
  PGPASSWORD="${PGPASSWORD}" psql -h "${PGHOST}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" \
    -v ON_ERROR_STOP=1 <<'EOSQL'
ALTER TABLE municipalities
  ADD COLUMN IF NOT EXISTS comune_montano_l131 BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN municipalities.comune_montano_l131 IS 'Comune montano ai sensi della L. 131/2025: valore dall''elenco ufficiale (rif. distribuzione ministeriale in PDF)';
EOSQL

  echo "Applying comuni montani flags..."
  PGPASSWORD="${PGPASSWORD}" psql -h "${PGHOST}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" \
    -v ON_ERROR_STOP=1 <<EOSQL
BEGIN;
CREATE TEMP TABLE _montani_l131 (
  sigla TEXT,
  comune TEXT
);

\copy _montani_l131 FROM '${csv}' WITH (FORMAT CSV, HEADER true, NULL '')

UPDATE municipalities AS m SET comune_montano_l131 = false;

UPDATE municipalities AS m
SET comune_montano_l131 = true
FROM provinces AS p, _montani_l131 AS s
WHERE m.cod_prov = p.cod_prov
  AND upper(trim(p.sigla)) = upper(trim(s.sigla))
  AND (
    lower(trim(m.comune)) = lower(trim(s.comune))
    OR (m.comune_a IS NOT NULL AND btrim(m.comune_a) <> '' AND lower(trim(m.comune_a)) = lower(trim(s.comune)))
  );

COMMIT;
EOSQL

  local ntrue
  ntrue=$(PGPASSWORD="${PGPASSWORD}" psql -h "${PGHOST}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" \
    -tAc "SELECT count(*) FROM municipalities WHERE comune_montano_l131 = true;")

  echo "Comuni segnati come montani (L.131): ${ntrue} (righe distinte PDF: $(($(wc -l < "${csv}") - 1)))."
  rm -f "${workdir}/parse.log"
}
