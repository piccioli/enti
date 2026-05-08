-- Aggiunge campi contatto/fiscali su database già popolati.
-- Esegui:
--   docker compose exec -T db psql -U postgres -d comuni < db/migrations/011_municipalities_contacts.sql

ALTER TABLE municipalities
  ADD COLUMN IF NOT EXISTS sito_web TEXT,
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS pec TEXT,
  ADD COLUMN IF NOT EXISTS telefono TEXT,
  ADD COLUMN IF NOT EXISTS codice_fiscale TEXT,
  ADD COLUMN IF NOT EXISTS indirizzo_fisico TEXT;

COMMENT ON COLUMN municipalities.sito_web IS 'Sito web istituzionale del comune (se noto, importato da sorgenti esterne)';
COMMENT ON COLUMN municipalities.email IS 'Email di contatto del comune (se nota, importata da sorgenti esterne)';
COMMENT ON COLUMN municipalities.pec IS 'PEC del comune (se nota, importata da sorgenti esterne)';
COMMENT ON COLUMN municipalities.telefono IS 'Contatto telefonico del comune (se noto, importato da sorgenti esterne)';
COMMENT ON COLUMN municipalities.codice_fiscale IS 'Codice fiscale/partita IVA del comune (se noto, importato da sorgenti esterne)';
COMMENT ON COLUMN municipalities.indirizzo_fisico IS 'Indirizzo fisico (sede municipale o sede principale; se noto, importato da sorgenti esterne)';

