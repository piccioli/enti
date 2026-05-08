-- Aggiunge flag L.131/2025 su database già popolati (volume esistenti).
-- Esegui: docker compose exec -T db psql -U postgres -d comuni < db/migrations/010_comune_montano_l131.sql
-- I valori boolean vanno compilati poi con: loader load_comuni_montani_l131_main

ALTER TABLE municipalities
  ADD COLUMN IF NOT EXISTS comune_montano_l131 BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN municipalities.comune_montano_l131 IS 'Comune montano ai sensi della L. 131/2025 (elenco da PDF ministeriale o copia locale in data/)';
