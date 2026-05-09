#!/usr/bin/env bash
# Importa un datapack (GeoJSON + JSON) nel database Postgres — senza download ISTAT.
#
# Variabili:
#   DATAPACK_DIR   directory contenente manifest.json ecc. (default: /datapack)
#
# Esempi ( dalla root progetto sul host ):
#   docker compose run --rm -v "$(pwd)/datapack-dist:/datapack:ro" loader bash /loader/import_datapack.sh
#
set -euo pipefail

DIR="${DATAPACK_DIR:-/datapack}"

MAN="${DIR}/manifest.json"
REG="${DIR}/regions.geojson"
PRV="${DIR}/provinces.geojson"
COM="${DIR}/municipalities.geojson"
TG="${DIR}/territorial_groups.json"

for f in "$MAN" "$REG" "$PRV" "$COM" "$TG"; do
  [[ -f "$f" ]] || { echo "ERROR: file datapack mancante: ${f}" >&2; exit 1; }
done

SCHEMA_EXPECTED="$(jq -r '.schema // empty' "$MAN")"
[[ "$SCHEMA_EXPECTED" == "comuni-datapack-v1" ]] || {
  echo "ERROR: manifest.schema atteso comuni-datapack-v1, trovato: '${SCHEMA_EXPECTED}'." >&2
  exit 1
}

TMPDIR="$(mktemp -d)"
trap 'rm -rf "${TMPDIR}"' EXIT

echo "=== Verifica checksum SHA-256 dal manifest ==="
verify_hash() {
  local key="$1" path="$2"
  local declared got
  declared="$(jq -r --arg k "$key" '.files[$k].sha256' "$MAN")"
  got="$(sha256sum "${path}" | awk '{print $1}')"
  if [[ "${declared}" != "${got}" ]]; then
    echo "ERROR: checksum errato per ${key}: dichiarato=${declared} attuale=${got}" >&2
    exit 1
  fi
}
verify_hash regions "$REG"
verify_hash provinces "$PRV"
verify_hash municipalities "$COM"
verify_hash territorial_groups "$TG"

if jq -e '.territorial_groups_meta | type=="object"' "$MAN" >/dev/null 2>&1; then
  FG="$(jq '.groups | length' "${TG}")"
  FM="$(jq '.members | length' "${TG}")"
  MG="$(jq -r '.territorial_groups_meta.groups_count // empty' "${MAN}")"
  MM="$(jq -r '.territorial_groups_meta.members_count // empty' "${MAN}")"
  [[ -n "${MG}" && "${MG}" != "${FG}" ]] && echo "WARN: manifest.territorial_groups_meta.groups_count (${MG}) ≠ file (${FG})" >&2
  [[ -n "${MM}" && "${MM}" != "${FM}" ]] && echo "WARN: manifest.territorial_groups_meta.members_count (${MM}) ≠ file (${FM})" >&2
  RYR="$(jq -r '.territorial_groups_meta.reference_year_max // empty' "${MAN}")"
  [[ -n "${RYR}" && "${RYR}" =~ ^[0-9]+$ ]] || true
fi

PG_CONN="PG:host=${PGHOST:-db} port=${PGPORT:-5432} dbname=${PGDATABASE} user=${PGUSER} password=${PGPASSWORD}"

echo "=== Svuota tabelle geografiche e raggruppamenti ==="
PGPASSWORD="${PGPASSWORD}" psql -h "${PGHOST:-db}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" -v ON_ERROR_STOP=1 <<'SQL'
TRUNCATE territorial_group_members;
TRUNCATE territorial_groups RESTART IDENTITY CASCADE;
TRUNCATE municipalities CASCADE;
TRUNCATE provinces CASCADE;
TRUNCATE regions CASCADE;
SQL

echo "[1/4] Import regions ..."
ogr2ogr -f PostgreSQL "${PG_CONN}" "${REG}" -nln regions -overwrite \
  -lco GEOMETRY_NAME=geom -nlt PROMOTE_TO_MULTI -t_srs EPSG:4326

echo "[2/4] Import provinces ..."
ogr2ogr -f PostgreSQL "${PG_CONN}" "${PRV}" -nln provinces -overwrite \
  -lco GEOMETRY_NAME=geom -nlt PROMOTE_TO_MULTI -t_srs EPSG:4326

echo "[3/4] Import municipalities (può durare alcuni minuti) ..."
ogr2ogr -f PostgreSQL "${PG_CONN}" "${COM}" -nln municipalities -overwrite \
  -lco GEOMETRY_NAME=geom -nlt PROMOTE_TO_MULTI -t_srs EPSG:4326

echo "[3b] post_load.sql (chiavi primarie + indici + colonne garantite) ..."
PGPASSWORD="${PGPASSWORD}" psql -h "${PGHOST:-db}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" \
  -v ON_ERROR_STOP=1 -f /loader/post_load.sql

echo "[4/4] Import territorial_groups + members ..."
G_COUNT="$(jq '.groups | length' "${TG}")"
M_COUNT="$(jq '.members | length' "${TG}")"

if [[ "${M_COUNT}" -gt 0 && "${G_COUNT}" -eq 0 ]]; then
  echo "ERROR: territorial_groups.members non vuoto ma .groups vuoto nel datapack." >&2
  exit 1
fi

GRP_CSV="${TMPDIR}/groups.csv"
MEM_CSV="${TMPDIR}/members.csv"

if [[ "${G_COUNT}" -gt 0 ]]; then
  jq -r '.groups[] |
    [
      .id,
      .slug,
      .label,
      .group_kind,
      (.notes // ""),
      (.valid_from // ""),
      (.valid_to // ""),
      (.source_name // ""),
      (.source_url // ""),
      (
        if .reference_year == null or (.reference_year | type) == "null" then ""
        elif (.reference_year | type) == "number" then (.reference_year | tonumber | tostring)
        else (.reference_year | tostring)
        end
      ),
      (.external_id // ""),
      (
        if ((.is_demo // false) == true) then "true"
        elif ((.is_demo // false) | type) == "string" then (if (.is_demo|ascii_downcase) == "true" then "true" else "false" end)
        else "false"
        end
      )
    ] | @csv' "${TG}" > "${GRP_CSV}"
else
  echo "(skip) Nessun territorial_group nel datapack."
fi

if [[ "${M_COUNT}" -gt 0 ]]; then
  jq -r '.members[] | [.group_id, .pro_com] | @csv' "${TG}" > "${MEM_CSV}"
fi

if [[ "${G_COUNT}" -gt 0 ]]; then
PGPASSWORD="${PGPASSWORD}" psql -h "${PGHOST:-db}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" -v ON_ERROR_STOP=1 <<EOSQL
CREATE TEMP TABLE _dp_groups (
  id integer,
  slug text,
  label text,
  group_kind text,
  notes text,
  valid_from text,
  valid_to text,
  source_name text,
  source_url text,
  reference_year text,
  external_id text,
  is_demo text
);
\copy _dp_groups (id, slug, label, group_kind, notes, valid_from, valid_to, source_name, source_url, reference_year, external_id, is_demo) FROM '${GRP_CSV}' WITH (FORMAT csv);

INSERT INTO territorial_groups (
  id, slug, label, group_kind, notes, valid_from, valid_to,
  source_name, source_url, reference_year, external_id, is_demo
)
SELECT
  g.id,
  g.slug,
  g.label,
  g.group_kind,
  NULLIF(btrim(g.notes), ''),
  NULLIF(btrim(g.valid_from), '')::date,
  NULLIF(btrim(g.valid_to), '')::date,
  NULLIF(btrim(g.source_name), ''),
  NULLIF(btrim(g.source_url), ''),
  CASE
    WHEN btrim(g.reference_year) = '' THEN NULL
    ELSE NULLIF(trim(g.reference_year), '')::smallint
  END,
  NULLIF(btrim(g.external_id), ''),
  (
    CASE
      WHEN btrim(lower(COALESCE(g.is_demo, ''))) IN ('t', 'true', '1') THEN TRUE
      ELSE FALSE
    END
  )
FROM _dp_groups g;

SELECT setval(
  pg_get_serial_sequence('territorial_groups', 'id'),
  GREATEST((SELECT COALESCE(MAX(id), 1) FROM territorial_groups), 1)
);
EOSQL
fi

if [[ "${M_COUNT}" -gt 0 ]]; then
PGPASSWORD="${PGPASSWORD}" psql -h "${PGHOST:-db}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" -v ON_ERROR_STOP=1 <<EOSQL
CREATE TEMP TABLE _dp_members (
  group_id integer,
  pro_com integer
);
\copy _dp_members (group_id, pro_com) FROM '${MEM_CSV}' WITH (FORMAT csv);

INSERT INTO territorial_group_members (group_id, pro_com)
SELECT m.group_id, m.pro_com FROM _dp_members m;
EOSQL
fi

FINAL=$(PGPASSWORD="${PGPASSWORD}" psql -h "${PGHOST:-db}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" \
  -tAc "SELECT count(*) FROM municipalities")

echo "=== Fatto. Comuni in DB: ${FINAL} (manifest: $(jq -r '.municipalities_count' "$MAN")) ==="
