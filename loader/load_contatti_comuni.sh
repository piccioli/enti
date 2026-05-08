#!/usr/bin/env bash
# Import contatti/fiscali comuni da CSV e aggiorna municipalities.
#
# CSV atteso (UTF-8, separatore virgola, header):
# pro_com,sito_web,email,pec,telefono,codice_fiscale,indirizzo_fisico

SCRIPT_DIR="${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"

load_contatti_comuni_main() {
  if [ "${SKIP_COMUNI_CONTATTI:-0}" = "1" ]; then
    echo "SKIP_COMUNI_CONTATTI=1: skipping comuni contacts import."
    return 0
  fi

  local csv="${COMUNI_CONTATTI_CSV:-/data/contatti-comuni.csv}"
  if [ ! -f "${csv}" ]; then
    echo "Comuni contatti CSV not found at ${csv}. Skipping." >&2
    return 0
  fi
  if [ ! -s "${csv}" ]; then
    echo "ERROR: contatti CSV vuoto: ${csv}" >&2
    return 1
  fi

  echo "Ensuring contatti columns on municipalities..."
  PGPASSWORD="${PGPASSWORD}" psql -h "${PGHOST}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" \
    -v ON_ERROR_STOP=1 <<'EOSQL'
ALTER TABLE municipalities
  ADD COLUMN IF NOT EXISTS sito_web TEXT,
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS pec TEXT,
  ADD COLUMN IF NOT EXISTS telefono TEXT,
  ADD COLUMN IF NOT EXISTS codice_fiscale TEXT,
  ADD COLUMN IF NOT EXISTS indirizzo_fisico TEXT;
EOSQL

  echo "Importing contatti from CSV: ${csv}"
  PGPASSWORD="${PGPASSWORD}" psql -h "${PGHOST}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" \
    -v ON_ERROR_STOP=1 <<EOSQL
BEGIN;
CREATE TEMP TABLE _contatti_comuni (
  pro_com INTEGER,
  sito_web TEXT,
  email TEXT,
  pec TEXT,
  telefono TEXT,
  codice_fiscale TEXT,
  indirizzo_fisico TEXT
);

\\copy _contatti_comuni FROM '${csv}' WITH (FORMAT CSV, HEADER true, NULL '');

UPDATE municipalities AS m
SET
  sito_web = NULLIF(btrim(c.sito_web), ''),
  email = NULLIF(btrim(c.email), ''),
  pec = NULLIF(btrim(c.pec), ''),
  telefono = NULLIF(btrim(c.telefono), ''),
  codice_fiscale = NULLIF(btrim(c.codice_fiscale), ''),
  indirizzo_fisico = NULLIF(btrim(c.indirizzo_fisico), '')
FROM _contatti_comuni AS c
WHERE m.pro_com::int = c.pro_com;

COMMIT;
EOSQL

  local n
  n=$(PGPASSWORD="${PGPASSWORD}" psql -h "${PGHOST}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" \
    -tAc "SELECT count(*) FROM municipalities WHERE sito_web IS NOT NULL OR email IS NOT NULL OR pec IS NOT NULL OR telefono IS NOT NULL OR codice_fiscale IS NOT NULL OR indirizzo_fisico IS NOT NULL;")
  echo "Comuni con almeno un contatto/fiscale valorizzato: ${n}"
}

