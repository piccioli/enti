#!/usr/bin/env bash
# Download ISTAT "Popolazione residente (POS)" from demo.istat.it provincial ZIP archives.
# Keeps Età = 999 row (Totale comunale) per CODICE_COMUNE (= pro_com ISTAT storico compatibile).

load_popolazione_main() {
  local CURL_ARGS=("-fsSL" "-A" "Mozilla/5.0 (WEBMAPP municipalities loader)")
  local demo_base="https://demo.istat.it"
  if [ "${CURL_INSECURE:-}" = "1" ]; then
    CURL_ARGS=("-fsSLk" "-A" "Mozilla/5.0 (WEBMAPP municipalities loader)")
    echo "(CURL_INSECURE=1: certificate verification disabled for population download)"
  fi

  local pop_year=""
  if [ -n "${ISTAT_POP_YEAR:-}" ]; then
    pop_year="${ISTAT_POP_YEAR}"
    echo "ISTAT_POP_YEAR=${pop_year} (from environment)"
  else
    echo "Discovering latest population reference year from demo ISTAT..."
    local page_shell
    page_shell=$(curl "${CURL_ARGS[@]}" "${demo_base}/app/?i=POS&l=it")
    pop_year="$(printf '%s' "${page_shell}" | grep -E 'option value="20[0-9]{2}"' \
      | grep 'selected="selected"' | head -1 \
      | sed -n 's/.*value="\([0-9]*\)".*/\1/p' || true)"
    if ! [[ "${pop_year}" =~ ^20[0-9]{2}$ ]]; then
      echo "WARN: Could not parse selected year from POS page; falling back to ISTAT_YEAR=${ISTAT_YEAR:-unset}."
      pop_year="${ISTAT_YEAR:-}"
    fi
    if ! [[ "${pop_year}" =~ ^20[0-9]{2}$ ]]; then
      echo "ERROR: Set ISTAT_POP_YEAR (e.g. 2026) if auto-discovery fails." >&2
      return 1
    fi
    echo "Population reference year detected: ${pop_year}"
  fi

  local workdir="${WORKDIR_POP:-/tmp/istat_pop_${pop_year}}"
  mkdir -p "${workdir}"
  local merged="${workdir}/pop_eta999.csv"
  rm -f "${merged}"

  echo "Fetching POS zip catalogue (${pop_year})..."
  local page_year
  page_year=$(curl "${CURL_ARGS[@]}" "${demo_base}/app/?i=POS&l=it&a=${pop_year}")

  mapfile -t zip_paths < <(printf '%s' "${page_year}" \
    | grep -oE '\.\./data/posas/POSAS_'"${pop_year}"'_[^"'\'']+\.zip' \
    | sort -u)

  if [ "${#zip_paths[@]}" -lt 90 ]; then
    echo "ERROR: Expected ~107 province ZIPs, found ${#zip_paths[@]}. ISTAT layout may have changed." >&2
    return 1
  fi

  echo "Extracting Età 999 totals from ${#zip_paths[@]} province ZIPs..."
  local zp url path rel
  for zp in "${zip_paths[@]}"; do
    rel="${zp#../}"
    url="${demo_base}/${rel}"
    path="${workdir}/$(basename "${zp}")"
    curl "${CURL_ARGS[@]}" "${url}" -o "${path}"
    unzip -p "${path}" '*.csv' | awk -F';' '
      NR > 2 && $3 == 999 {
        cod = $1; gsub(/^"|"$/, "", cod); gsub(/\r$/, "", cod)
        tot = $6; gsub(/^"|"$/, "", tot); gsub(/\r$/, "", tot)
        printf "%s,%s\n", cod, tot
      }
    ' >> "${merged}"
    rm -f "${path}"
  done

  local lines
  lines=$(wc -l < "${merged}" | tr -d ' ')
  echo "Prepared ${lines} municipality population totals (reference 1 Jan ${pop_year})."

  echo "Loading into municipalities.popolazione_residente ..."
  PGPASSWORD="${PGPASSWORD}" psql -h "${PGHOST}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" \
    -v ON_ERROR_STOP=1 <<EOSQL
BEGIN;
CREATE TEMP TABLE _pop_istat (
  codice TEXT,
  totale INTEGER
);

\copy _pop_istat FROM '${merged}' WITH (FORMAT CSV)

UPDATE municipalities AS m
SET
  popolazione_residente = p.totale,
  popolazione_istat_anno = ${pop_year}::smallint
FROM _pop_istat AS p
WHERE m.pro_com = CAST(trim(p.codice) AS integer);

COMMIT;
EOSQL

  PGPASSWORD="${PGPASSWORD}" psql -h "${PGHOST}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" \
    -v ON_ERROR_STOP=1 -tAc "
    SELECT cast(count(*) AS text) FROM municipalities WHERE popolazione_residente IS NOT NULL;
  " | {
    read -r nset || true
    echo "Updated population for ${nset:-0} municipalities."
  }

  rm -f "${merged}"
}
