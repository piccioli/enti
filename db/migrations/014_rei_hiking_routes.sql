-- Sentieri del Catasto REI (CAI) — SDA 3 e 4.
-- Eseguire dopo che esistono municipalities e protected_areas:
--   docker compose exec -T db psql -U postgres -d comuni < db/migrations/014_rei_hiking_routes.sql

CREATE TABLE IF NOT EXISTS rei_hiking_routes (
  id INTEGER PRIMARY KEY,
  relation_id BIGINT,
  ref TEXT,
  ref_rei TEXT,
  name TEXT,
  sda SMALLINT NOT NULL CHECK (sda IN (3, 4)),
  cai_scale TEXT,
  cai_scale_string TEXT,
  from_loc TEXT,
  to_loc TEXT,
  city_from TEXT,
  city_from_istat TEXT,
  region_from TEXT,
  region_from_istat TEXT,
  city_to TEXT,
  city_to_istat TEXT,
  region_to TEXT,
  region_to_istat TEXT,
  distance_km DOUBLE PRECISION,
  ascent_m INTEGER,
  descent_m INTEGER,
  ele_min_m INTEGER,
  ele_max_m INTEGER,
  ele_from_m INTEGER,
  ele_to_m INTEGER,
  duration_forward_min INTEGER,
  duration_backward_min INTEGER,
  roundtrip BOOLEAN,
  abstract TEXT,
  gpx_url TEXT,
  validation_date DATE,
  survey_date DATE,
  osm2cai_status TEXT,
  source_url TEXT,
  updated_at TIMESTAMPTZ NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  geom GEOMETRY(MultiLineString, 4326) NOT NULL
);

CREATE INDEX IF NOT EXISTS rei_hr_geom_gix ON rei_hiking_routes USING GIST (geom);
CREATE INDEX IF NOT EXISTS rei_hr_sda_idx ON rei_hiking_routes (sda);

COMMENT ON TABLE rei_hiking_routes IS 'Sentieri Catasto REI (CAI) SDA 3–4 importati in build da GeoJSON in datapack-dist/sentier';
COMMENT ON COLUMN rei_hiking_routes.id IS 'ID numerico OSM2CAI (stabile, usato come PK)';
COMMENT ON COLUMN rei_hiking_routes.sda IS 'Stato di accatastamento: 3=ready, 4=validated';

-- Dettaglio per QA e per endpoint "sentieri di un comune"
CREATE TABLE IF NOT EXISTS municipality_rei_hiking_routes (
  pro_com INTEGER NOT NULL REFERENCES municipalities (pro_com) ON DELETE CASCADE,
  osm2cai_id INTEGER NOT NULL REFERENCES rei_hiking_routes (id) ON DELETE CASCADE,
  sda SMALLINT NOT NULL,
  km_inside DOUBLE PRECISION NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (pro_com, osm2cai_id)
);
CREATE INDEX IF NOT EXISTS mhr_pro_com_idx ON municipality_rei_hiking_routes (pro_com);

COMMENT ON TABLE municipality_rei_hiking_routes IS 'Km di ogni sentiero REI all''interno di ogni comune (solo intersezione)';

-- Aggregato per comune/SDA
CREATE TABLE IF NOT EXISTS municipality_rei_stats (
  pro_com INTEGER NOT NULL REFERENCES municipalities (pro_com) ON DELETE CASCADE,
  sda SMALLINT NOT NULL CHECK (sda IN (3, 4)),
  km_inside DOUBLE PRECISION NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (pro_com, sda)
);

COMMENT ON TABLE municipality_rei_stats IS 'Km totali sentieri REI SDA 3/4 dentro ciascun comune';

-- Dettaglio per QA e per endpoint "sentieri di un parco"
CREATE TABLE IF NOT EXISTS protected_area_rei_hiking_routes (
  protected_area_id INTEGER NOT NULL REFERENCES protected_areas (id) ON DELETE CASCADE,
  osm2cai_id INTEGER NOT NULL REFERENCES rei_hiking_routes (id) ON DELETE CASCADE,
  sda SMALLINT NOT NULL,
  km_inside DOUBLE PRECISION NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (protected_area_id, osm2cai_id)
);
CREATE INDEX IF NOT EXISTS pahr_pa_idx ON protected_area_rei_hiking_routes (protected_area_id);

COMMENT ON TABLE protected_area_rei_hiking_routes IS 'Km di ogni sentiero REI all''interno di ogni parco (solo intersezione)';

-- Aggregato per parco/SDA
CREATE TABLE IF NOT EXISTS protected_area_rei_stats (
  protected_area_id INTEGER NOT NULL REFERENCES protected_areas (id) ON DELETE CASCADE,
  sda SMALLINT NOT NULL CHECK (sda IN (3, 4)),
  km_inside DOUBLE PRECISION NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (protected_area_id, sda)
);

COMMENT ON TABLE protected_area_rei_stats IS 'Km totali sentieri REI SDA 3/4 dentro ciascun parco';

-- Aggregato per gruppo territoriale/SDA
CREATE TABLE IF NOT EXISTS territorial_group_rei_stats (
  group_id INTEGER NOT NULL REFERENCES territorial_groups (id) ON DELETE CASCADE,
  sda SMALLINT NOT NULL CHECK (sda IN (3, 4)),
  km_inside DOUBLE PRECISION NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, sda)
);

COMMENT ON TABLE territorial_group_rei_stats IS 'Km totali sentieri REI SDA 3/4 dentro l''area di ciascun raggruppamento territoriale';
