-- Metadati fonte e anno di riferimento per raggruppamenti territoriali.
-- Esecuzione DB già inizializzato:
--   docker compose exec -T db psql -U postgres -d comuni < db/migrations/012_territorial_groups_metadata.sql

ALTER TABLE territorial_groups
  ADD COLUMN IF NOT EXISTS source_name TEXT,
  ADD COLUMN IF NOT EXISTS source_url TEXT,
  ADD COLUMN IF NOT EXISTS reference_year SMALLINT,
  ADD COLUMN IF NOT EXISTS external_id TEXT,
  ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN territorial_groups.source_name IS 'Identificativo breve della fonte istituzionale (es. open data regionale o ministeriale)';
COMMENT ON COLUMN territorial_groups.source_url IS 'URL del dataset / risorsa open data utilizzato per l estrazione';
COMMENT ON COLUMN territorial_groups.reference_year IS 'Anno statuto / riferimento dichiarativo del dataset';
COMMENT ON COLUMN territorial_groups.external_id IS 'Chiave primaria nell origine quando disponibile (evita slug non stabili)';
COMMENT ON COLUMN territorial_groups.is_demo IS 'True per record dimostrativi non da usare in produzione';

CREATE UNIQUE INDEX IF NOT EXISTS territorial_groups_source_external_unique
  ON territorial_groups (source_name, external_id)
  WHERE source_name IS NOT NULL AND btrim(external_id) <> '';

CREATE INDEX IF NOT EXISTS territorial_groups_demo_idx ON territorial_groups (is_demo) WHERE is_demo;

CREATE INDEX IF NOT EXISTS territorial_groups_fts_it_idx ON territorial_groups USING gin (
  (to_tsvector('italian', coalesce(label, '') || ' ' || coalesce(slug, '')))
);
