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

echo "=== Migrazione 013 (aree protette) — idempotente ==="
PGPASSWORD="${PGPASSWORD}" psql -h "${PGHOST:-db}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" -v ON_ERROR_STOP=1 <<'SQL'
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE IF NOT EXISTS protected_areas (
  id SERIAL PRIMARY KEY,
  external_code TEXT,
  name TEXT NOT NULL,
  area_type TEXT,
  source_name TEXT,
  geom geometry(MultiPolygon, 4326) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS protected_areas_external_code_unique
  ON protected_areas (external_code)
  WHERE external_code IS NOT NULL AND btrim(external_code) <> '';
CREATE INDEX IF NOT EXISTS protected_areas_geom_idx ON protected_areas USING GIST (geom);
CREATE INDEX IF NOT EXISTS protected_areas_name_trgm_idx ON protected_areas USING gin (name gin_trgm_ops);
CREATE TABLE IF NOT EXISTS municipality_protected_area (
  pro_com INTEGER NOT NULL REFERENCES municipalities (pro_com) ON DELETE CASCADE,
  protected_area_id INTEGER NOT NULL REFERENCES protected_areas (id) ON DELETE CASCADE,
  PRIMARY KEY (pro_com, protected_area_id)
);
CREATE INDEX IF NOT EXISTS municipality_protected_area_area_idx
  ON municipality_protected_area (protected_area_id);
SQL

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
echo "[4a] Ensure territorial_groups metadata columns exist ..."
PGPASSWORD="${PGPASSWORD}" psql -h "${PGHOST:-db}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" -v ON_ERROR_STOP=1 <<'SQL'
ALTER TABLE territorial_groups
  ADD COLUMN IF NOT EXISTS source_name TEXT,
  ADD COLUMN IF NOT EXISTS source_url TEXT,
  ADD COLUMN IF NOT EXISTS reference_year SMALLINT,
  ADD COLUMN IF NOT EXISTS external_id TEXT,
  ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS territorial_groups_source_external_unique
  ON territorial_groups (source_name, external_id)
  WHERE source_name IS NOT NULL AND btrim(external_id) <> '';

CREATE INDEX IF NOT EXISTS territorial_groups_demo_idx
  ON territorial_groups (is_demo)
  WHERE is_demo;

CREATE INDEX IF NOT EXISTS territorial_groups_fts_it_idx
  ON territorial_groups USING gin (
    (to_tsvector('italian', coalesce(label, '') || ' ' || coalesce(slug, '')))
  );
SQL

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

echo "=== Migrazione 014 (sentieri REI) — idempotente ==="
PGPASSWORD="${PGPASSWORD}" psql -h "${PGHOST:-db}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE IF NOT EXISTS rei_hiking_routes (
  id INTEGER PRIMARY KEY,
  relation_id BIGINT, ref TEXT, ref_rei TEXT, name TEXT,
  sda SMALLINT NOT NULL CHECK (sda IN (3, 4)),
  cai_scale TEXT, cai_scale_string TEXT,
  from_loc TEXT, to_loc TEXT,
  city_from TEXT, city_from_istat TEXT, region_from TEXT, region_from_istat TEXT,
  city_to TEXT, city_to_istat TEXT, region_to TEXT, region_to_istat TEXT,
  distance_km DOUBLE PRECISION,
  ascent_m INTEGER, descent_m INTEGER,
  ele_min_m INTEGER, ele_max_m INTEGER, ele_from_m INTEGER, ele_to_m INTEGER,
  duration_forward_min INTEGER, duration_backward_min INTEGER,
  roundtrip BOOLEAN, abstract TEXT, gpx_url TEXT,
  validation_date DATE, survey_date DATE, osm2cai_status TEXT,
  source_url TEXT, updated_at TIMESTAMPTZ NOT NULL, fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  geom GEOMETRY(MultiLineString, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS rei_hr_geom_gix ON rei_hiking_routes USING GIST (geom);
CREATE INDEX IF NOT EXISTS rei_hr_sda_idx ON rei_hiking_routes (sda);

CREATE TABLE IF NOT EXISTS municipality_rei_hiking_routes (
  pro_com INTEGER NOT NULL REFERENCES municipalities (pro_com) ON DELETE CASCADE,
  osm2cai_id INTEGER NOT NULL REFERENCES rei_hiking_routes (id) ON DELETE CASCADE,
  sda SMALLINT NOT NULL, km_inside DOUBLE PRECISION NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (pro_com, osm2cai_id)
);
CREATE INDEX IF NOT EXISTS mhr_pro_com_idx ON municipality_rei_hiking_routes (pro_com);

CREATE TABLE IF NOT EXISTS municipality_rei_stats (
  pro_com INTEGER NOT NULL REFERENCES municipalities (pro_com) ON DELETE CASCADE,
  sda SMALLINT NOT NULL CHECK (sda IN (3, 4)), km_inside DOUBLE PRECISION NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (pro_com, sda)
);

CREATE TABLE IF NOT EXISTS protected_area_rei_hiking_routes (
  protected_area_id INTEGER NOT NULL REFERENCES protected_areas (id) ON DELETE CASCADE,
  osm2cai_id INTEGER NOT NULL REFERENCES rei_hiking_routes (id) ON DELETE CASCADE,
  sda SMALLINT NOT NULL, km_inside DOUBLE PRECISION NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (protected_area_id, osm2cai_id)
);
CREATE INDEX IF NOT EXISTS pahr_pa_idx ON protected_area_rei_hiking_routes (protected_area_id);

CREATE TABLE IF NOT EXISTS protected_area_rei_stats (
  protected_area_id INTEGER NOT NULL REFERENCES protected_areas (id) ON DELETE CASCADE,
  sda SMALLINT NOT NULL CHECK (sda IN (3, 4)), km_inside DOUBLE PRECISION NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (protected_area_id, sda)
);

CREATE TABLE IF NOT EXISTS territorial_group_rei_stats (
  group_id INTEGER NOT NULL REFERENCES territorial_groups (id) ON DELETE CASCADE,
  sda SMALLINT NOT NULL CHECK (sda IN (3, 4)), km_inside DOUBLE PRECISION NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, sda)
);
SQL

FINAL=$(PGPASSWORD="${PGPASSWORD}" psql -h "${PGHOST:-db}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" \
  -tAc "SELECT count(*) FROM municipalities")

echo "=== Fatto. Comuni in DB: ${FINAL} (manifest: $(jq -r '.municipalities_count' "$MAN")) ==="
