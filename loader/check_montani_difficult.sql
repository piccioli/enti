-- Richiede: psql variable csv_for_copy = path raggiungibile dal client (\copy)
\set ON_ERROR_STOP on

-- Montare il CSV come /tmp/montani.csv sul client psql (\copy legge dal client).
BEGIN;

DROP TABLE IF EXISTS _pdf_m;
CREATE TEMP TABLE _pdf_m (
  sigla text NOT NULL,
  comune text NOT NULL
);
\copy _pdf_m(sigla, comune) FROM '/tmp/montani.csv' WITH (FORMAT csv, HEADER true);

ALTER TABLE _pdf_m
  ADD COLUMN apostrophe_pdf boolean GENERATED ALWAYS AS (
    comune ~ '[^\x01-\x7f]' OR strpos(comune, '''') > 0 OR strpos(comune, chr(8217)) > 0
  ) STORED,
  ADD COLUMN hyphen_pdf boolean GENERATED ALWAYS AS (strpos(comune, '-') > 0) STORED;

CREATE TEMP TABLE _match_strict AS
SELECT DISTINCT s.sigla AS pdf_sigla, s.comune AS pdf_comune, m.pro_com, m.comune AS db_comune, m.comune_a
FROM _pdf_m s
JOIN provinces p ON upper(trim(p.sigla)) = upper(trim(s.sigla))
JOIN municipalities m ON m.cod_prov = p.cod_prov
  AND (
    lower(trim(m.comune)) = lower(trim(s.comune))
    OR (m.comune_a IS NOT NULL AND btrim(m.comune_a) <> '' AND lower(trim(m.comune_a)) = lower(trim(s.comune)))
  );

CREATE OR REPLACE FUNCTION _norm_mont_name(t text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(trim(regexp_replace(regexp_replace(regexp_replace(COALESCE($1, ''),
    chr(8217), '''', 'g'),
    chr(8216), '''', 'g'),
    E'\\s+', ' ', 'g')));
$$;

CREATE TEMP TABLE _match_norm AS
SELECT DISTINCT s.sigla AS pdf_sigla, s.comune AS pdf_comune, m.pro_com, m.comune AS db_comune, m.comune_a
FROM _pdf_m s
JOIN provinces p ON upper(trim(p.sigla)) = upper(trim(s.sigla))
JOIN municipalities m ON m.cod_prov = p.cod_prov
  AND (
    _norm_mont_name(m.comune) = _norm_mont_name(s.comune)
    OR (
      m.comune_a IS NOT NULL AND btrim(m.comune_a) <> ''
      AND _norm_mont_name(m.comune_a) = _norm_mont_name(s.comune)
    )
  );

CREATE TEMP TABLE _unmatched_norm AS
SELECT s.*
FROM _pdf_m s
WHERE NOT EXISTS (
  SELECT 1 FROM _match_norm mn
  WHERE mn.pdf_sigla = s.sigla AND mn.pdf_comune = s.comune
);

\echo '──────── Riepilogo match ────────'
SELECT
  (SELECT count(*) FROM _pdf_m) AS pdf_rows,
  (SELECT count(*) FROM _match_strict) AS matched_loader_logic,
  (SELECT count(*) FROM _pdf_m) - (SELECT count(*) FROM _match_strict) AS unmatched_loader_logic,
  (SELECT count(*) FROM _match_norm) AS matched_with_apostrophe_space_norm,
  (SELECT count(*) FROM _pdf_m) - (SELECT count(*) FROM _match_norm) AS still_unmatched;

\echo ''
\echo '──────── PDF con apostrofo / Unicode / trattino, ancora unmatched dopo normalizza (max 50) ────────'
SELECT sigla AS pdf_sigla, comune AS pdf_comune, apostrophe_pdf, hyphen_pdf
FROM _unmatched_norm
WHERE apostrophe_pdf OR hyphen_pdf
ORDER BY sigla, comune
LIMIT 50;

\echo ''
\echo '──────── Tutti gli unmatched dopo normalizza (cap 35) ────────'
SELECT sigla AS pdf_sigla, comune AS pdf_comune
FROM _unmatched_norm
ORDER BY sigla, comune
LIMIT 35;

\echo ''
\echo '──────── Candidati stessa provincia, primi 5 caratteri uguali — diagnostica ────────'
SELECT DISTINCT u.sigla AS pdf_sigla, u.comune AS pdf_comune, m.pro_com, m.comune AS db_comune, m.comune_a
FROM _unmatched_norm u
JOIN provinces p ON upper(trim(p.sigla)) = upper(trim(u.sigla))
JOIN municipalities m ON m.cod_prov = p.cod_prov
  AND lower(left(btrim(m.comune), 5)) = lower(left(btrim(u.comune), 5))
ORDER BY u.sigla, u.comune
LIMIT 30;

DROP FUNCTION _norm_mont_name(text);

COMMIT;
