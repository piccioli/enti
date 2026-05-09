-- Raggruppamenti territoriali (unioni di comuni, comunità montane, ecc.)

CREATE TABLE IF NOT EXISTS territorial_groups (
  id SERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  group_kind TEXT NOT NULL CHECK (group_kind IN (
    'unioni_di_comuni',
    'unioni_montane',
    'comunita_montane',
    'consorzi',
    'citta_metropolitane',
    'parchi_e_riserve',
    'gal_leader',
    'aree_interne',
    'altro'
  )),
  notes TEXT,
  valid_from DATE,
  valid_to DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_name TEXT,
  source_url TEXT,
  reference_year SMALLINT,
  external_id TEXT,
  is_demo BOOLEAN NOT NULL DEFAULT false
);

COMMENT ON COLUMN territorial_groups.source_name IS 'Identificativo breve della fonte istituzionale (es. open data regionale o ministeriale)';
COMMENT ON COLUMN territorial_groups.source_url IS 'URL del dataset / risorsa open data utilizzato per l estrazione';
COMMENT ON COLUMN territorial_groups.reference_year IS 'Anno statuto / riferimento dichiarativo del dataset';
COMMENT ON COLUMN territorial_groups.external_id IS 'Chiave primaria nell origine quando disponibile';
COMMENT ON COLUMN territorial_groups.is_demo IS 'True per record dimostrativi';

CREATE UNIQUE INDEX IF NOT EXISTS territorial_groups_source_external_unique
  ON territorial_groups (source_name, external_id)
  WHERE source_name IS NOT NULL AND btrim(external_id) <> '';

CREATE INDEX IF NOT EXISTS territorial_groups_demo_idx ON territorial_groups (is_demo) WHERE is_demo;

CREATE INDEX IF NOT EXISTS territorial_groups_fts_it_idx ON territorial_groups USING gin (
  (to_tsvector('italian', coalesce(label, '') || ' ' || coalesce(slug, '')))
);

CREATE TABLE IF NOT EXISTS territorial_group_members (
  group_id INTEGER NOT NULL REFERENCES territorial_groups (id) ON DELETE CASCADE,
  pro_com INTEGER NOT NULL,
  joined_at DATE NOT NULL DEFAULT CURRENT_DATE,
  PRIMARY KEY (group_id, pro_com)
);

CREATE INDEX IF NOT EXISTS territorial_groups_kind_idx ON territorial_groups (group_kind);
CREATE INDEX IF NOT EXISTS territorial_group_members_pro_com_idx ON territorial_group_members (pro_com);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'municipalities'
  ) THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'territorial_group_members_pro_com_fkey'
    ) THEN
      ALTER TABLE territorial_group_members
        ADD CONSTRAINT territorial_group_members_pro_com_fkey
        FOREIGN KEY (pro_com) REFERENCES municipalities (pro_com) ON DELETE CASCADE;
    END IF;
  END IF;
END
$$;

-- Dati demo: opzionale, vedi db/seeds/demo_territorial_groups.sql (caricamento dopo municipalities).
