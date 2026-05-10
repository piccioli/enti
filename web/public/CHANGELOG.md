# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-05-10
### Added
- **Sentieri REI (CAI, SDA 3–4):** import in build da GeoJSON precaricati in `datapack-dist/sentieri` (o `sentier`), senza download dall’API OSM2CAI; deduplica dello stesso `id` tra file di regioni diverse (priorità SDA più alta, poi `updated_at` più recente).
- Endpoint **`GET /api/rei-summary`** (conteggio sentieri e km totali da geometrie) e riepilogo **km sentieri (REI)** nella riga statistiche in header.

### Changed
- Tabella comuni: intestazione **Sentieri (km)** allineata al primo caricamento (`applyTheadForMode` all’avvio e `index.html`).
- Script **`scripts/deploy.sh`** documentato come entrypoint di deploy dello stack (`docker compose up -d --build`).

## [0.2.0] - 2026-05-09
### Added
- Modalità ricerca **Parchi / aree protette (EUAP)**: layer sulla mappa (Leaflet), tabella elenco e dettaglio in popup.
- Pipeline di import PostGIS e API per le aree protette (`/api/protected-areas`, incluso GeoJSON per la mappa).
- Pannello **filtro tipologie EUAP**: sigla, nome, numero di elementi nell’ambito corrente; colori distinti per tipologia; ordinamento fisso delle sigle; pulsante «Tutte» per riattivare tutti i tipi sulla mappa.

### Changed
- In vista parchi, confini regionali sempre visibili come contorno non interattivo; vista iniziale sulle aree EUAP nel contesto scelto.

### Fixed
- Interazione in mappa in modalità parchi (click sugli EUAP, ordine dei layer rispetto ai confini).

## [0.1.0] - 2026-05-09
### Added
- First public release of the “Comuni d'Italia — CRM” stack (web + API + loader + PostGIS).
- Interactive map UI (Leaflet), filtering, and municipality detail popup.
- Datapack build/export/import scripts and manifest checksums.
- Territorial groups (unioni/comunità montane, etc.) endpoints and import utilities.
