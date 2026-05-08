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
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS territorial_group_members (
  group_id INTEGER NOT NULL REFERENCES territorial_groups (id) ON DELETE CASCADE,
  -- municipalities viene creata dal loader; in init può non esistere ancora.
  -- Il vincolo FK (se desiderato) verrà aggiunto solo quando la tabella è presente.
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

-- Dati dimostrativi (2 comuni in provincia di Pisa + 2 in provincia di Sondrio)
INSERT INTO territorial_groups (slug, label, group_kind, notes)
VALUES
  ('esempio-unione-pisano',
   'Unione di comuni di esempio (area pisana)',
   'unioni_di_comuni',
   'Dati dimostrativi: primi 2 comuni per nome in provincia Pisa.'),
  ('esempio-comunita-montana',
   'Comunità montana — esempio (area valtellinese)',
   'comunita_montane',
   'Dati dimostrativi: 2 comuni in provincia Sondrio.')
ON CONFLICT (slug) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'municipalities'
  ) THEN
    INSERT INTO territorial_group_members (group_id, pro_com)
    SELECT g.id, m.pro_com
    FROM territorial_groups g
    JOIN LATERAL (
      SELECT pro_com FROM municipalities WHERE cod_prov = 50 ORDER BY comune ASC LIMIT 2
    ) m ON true
    WHERE g.slug = 'esempio-unione-pisano'
    ON CONFLICT DO NOTHING;

    INSERT INTO territorial_group_members (group_id, pro_com)
    SELECT g.id, m.pro_com
    FROM territorial_groups g
    JOIN LATERAL (
      SELECT pro_com FROM municipalities WHERE cod_prov = 14 ORDER BY comune ASC LIMIT 2
    ) m ON true
    WHERE g.slug = 'esempio-comunita-montana'
    ON CONFLICT DO NOTHING;
  END IF;
END
$$;
