-- Aree naturali protette (geometrie + metadati). Eseguire dopo che esiste `municipalities`:
--   docker compose exec -T db psql -U postgres -d comuni < db/migrations/013_protected_areas.sql

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS protected_areas (
  id SERIAL PRIMARY KEY,
  external_code TEXT,
  name TEXT NOT NULL,
  area_type TEXT,
  source_name TEXT,
  geom geometry(MultiPolygon, 4326) NOT NULL
);

COMMENT ON TABLE protected_areas IS 'Aree protette importate nel datapack (shapefile/geojson)';
COMMENT ON COLUMN protected_areas.external_code IS 'Codice/ID dalla fonte dati quando disponibile';
COMMENT ON COLUMN protected_areas.area_type IS 'Tipologia (EUAP, parco regionale, …) dalla fonte';
COMMENT ON COLUMN protected_areas.source_name IS 'Nome breve del dataset di provenienza';

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

COMMENT ON TABLE municipality_protected_area IS 'Associazione comune–area se i poligoni si intersecano (calcolo in build)';
