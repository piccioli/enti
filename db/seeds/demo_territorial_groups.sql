-- Dati dimostrativi opzionali (non eseguito da docker-entrypoint-initdb.d).
-- Applica dopo aver caricato i comuni (loader), ad esempio:
--   docker compose exec -T db psql -U postgres -d comuni < db/seeds/demo_territorial_groups.sql

INSERT INTO territorial_groups (slug, label, group_kind, notes, is_demo)
VALUES
  ('esempio-unione-pisano',
   'Unione di comuni di esempio (area pisana)',
   'unioni_di_comuni',
   'Demo: primi 2 comuni per nome in provincia Pisa.',
   true),
  ('esempio-comunita-montana',
   'Comunità montana — esempio (area valtellinese)',
   'comunita_montane',
   'Demo: 2 comuni in provincia Sondrio.',
   true)
ON CONFLICT (slug) DO NOTHING;

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
