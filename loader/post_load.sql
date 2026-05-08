-- Post-load: promote natural keys as PKs, add spatial indexes

-- regions
ALTER TABLE regions DROP CONSTRAINT IF EXISTS regions_pkey;
ALTER TABLE regions DROP COLUMN IF EXISTS ogc_fid;
ALTER TABLE regions ADD PRIMARY KEY (cod_reg);
CREATE INDEX IF NOT EXISTS regions_geom_idx ON regions USING GIST (geom);

-- provinces
ALTER TABLE provinces DROP CONSTRAINT IF EXISTS provinces_pkey;
ALTER TABLE provinces DROP COLUMN IF EXISTS ogc_fid;
ALTER TABLE provinces ADD PRIMARY KEY (cod_prov);
CREATE INDEX IF NOT EXISTS provinces_geom_idx ON provinces USING GIST (geom);
CREATE INDEX IF NOT EXISTS provinces_cod_reg_idx ON provinces (cod_reg);

-- municipalities
ALTER TABLE municipalities DROP CONSTRAINT IF EXISTS municipalities_pkey;
ALTER TABLE municipalities DROP COLUMN IF EXISTS ogc_fid;
ALTER TABLE municipalities ADD PRIMARY KEY (pro_com);
ALTER TABLE municipalities
  ADD COLUMN IF NOT EXISTS popolazione_residente INTEGER,
  ADD COLUMN IF NOT EXISTS popolazione_istat_anno SMALLINT,
  ADD COLUMN IF NOT EXISTS altitudine_min_sl_m INTEGER,
  ADD COLUMN IF NOT EXISTS altitudine_max_sl_m INTEGER,
  ADD COLUMN IF NOT EXISTS altitudine_media_sl_m NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS altitudine_centro_municipio_sl_m INTEGER,
  ADD COLUMN IF NOT EXISTS altitudine_istat_anno SMALLINT,
  ADD COLUMN IF NOT EXISTS comune_montano_l131 BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sito_web TEXT,
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS pec TEXT,
  ADD COLUMN IF NOT EXISTS telefono TEXT,
  ADD COLUMN IF NOT EXISTS codice_fiscale TEXT,
  ADD COLUMN IF NOT EXISTS indirizzo_fisico TEXT;
COMMENT ON COLUMN municipalities.popolazione_residente IS 'Popolazione residente comunale totale ISTAT POS (Età 999)';
COMMENT ON COLUMN municipalities.popolazione_istat_anno IS 'Anno referenza DEMO ISTAT (= 1º gennaio di quell anno)';
COMMENT ON COLUMN municipalities.altitudine_min_sl_m IS 'Altitudine minima sul territorio comunale (ISTAT, DEM Ispra, m s.l.m.)';
COMMENT ON COLUMN municipalities.altitudine_max_sl_m IS 'Altitudine massima sul territorio comunale (ISTAT, DEM Ispra, m s.l.m.)';
COMMENT ON COLUMN municipalities.altitudine_media_sl_m IS 'Altitudine media sul territorio comunale (ISTAT, DEM Ispra, m s.l.m.)';
COMMENT ON COLUMN municipalities.altitudine_centro_municipio_sl_m IS 'Quota al centroide del comune (ISTAT)';
COMMENT ON COLUMN municipalities.altitudine_istat_anno IS 'Anno/chiusura statistiche altimetria ISTAT nel dataset (Es. rif. territoriale 31/12/anno)';
COMMENT ON COLUMN municipalities.comune_montano_l131 IS 'Comune montano ai sensi della L. 131/2025 (elenco da PDF ministeriale o copia locale montata in /data)';
COMMENT ON COLUMN municipalities.sito_web IS 'Sito web istituzionale del comune (se noto, importato da sorgenti esterne)'; 
COMMENT ON COLUMN municipalities.email IS 'Email di contatto del comune (se nota, importata da sorgenti esterne)';
COMMENT ON COLUMN municipalities.pec IS 'PEC del comune (se nota, importata da sorgenti esterne)';
COMMENT ON COLUMN municipalities.telefono IS 'Contatto telefonico del comune (se noto, importato da sorgenti esterne)';
COMMENT ON COLUMN municipalities.codice_fiscale IS 'Codice fiscale/partita IVA del comune (se noto, importato da sorgenti esterne)';
COMMENT ON COLUMN municipalities.indirizzo_fisico IS 'Indirizzo fisico (sede municipale o sede principale; se noto, importato da sorgenti esterne)';
CREATE INDEX IF NOT EXISTS municipalities_geom_idx ON municipalities USING GIST (geom);
CREATE INDEX IF NOT EXISTS municipalities_cod_reg_idx ON municipalities (cod_reg);
CREATE INDEX IF NOT EXISTS municipalities_cod_prov_idx ON municipalities (cod_prov);
CREATE INDEX IF NOT EXISTS municipalities_comune_idx ON municipalities USING gin (to_tsvector('italian', comune));

ANALYZE regions;
ANALYZE provinces;
ANALYZE municipalities;
