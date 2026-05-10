# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-05-10
### Added
- **Tab di vista nell'header**: navigazione a 4 voci `Mappa | Comuni | Aggregazioni | Parchi`. Le viste tabellari sono alternative alla mappa (la mappa scompare quando attivi una lista).
- **Vista tabellare Aggregazioni** con colonne `Regioni`, `Province`, `Popolazione totale`, `Superficie km²`, `Sentieri (km)`; numero comuni cliccabile → popup elenco membri.
- **Vista tabellare Parchi** estesa con `Comuni` (cliccabile → popup), `Regioni`, `Province`, `Popolazione`.
- **Filtro tipologie EUAP** attivo anche in vista tabellare Parchi: il pannello viene popolato via `GET /api/protected-areas/types` (aggregato leggero) e applica una whitelist al backend tramite il nuovo parametro `types=` di `GET /api/protected-areas` (sentinel `__empty__` per `area_type` NULL/vuoto).
- **Ordinamento colonne client-side** della pagina corrente con persistenza per vista in `localStorage` (`webmapp_sort_comuni|aggregazioni|parchi`).
- Endpoint `GET /api/protected-areas/:id/municipalities` per l'elenco comuni intersecanti un'area protetta.
- Endpoint `GET /api/protected-areas/types` per il conteggio per `area_type` (opzionali `reg`/`prov`).
- Statistiche aggregate su `GET /api/groups`: `regions_touched`, `provinces_touched`, `population_total`, `area_km2_total`, `km_sentieri_total`.
- Statistiche aggregate su `GET /api/protected-areas`: `regions_touched`, `provinces_touched`, `member_count`, `population_total`.

### Changed
- Layout principale: in vista lista la sidebar diventa rail filtri (resizable, con persistenza separata in `localStorage` per modalità mappa e modalità liste); la tabella riempie l'area centrale.
- Denominazione di Aggregazioni e Parchi su più righe a larghezza fissa per non troncare i nomi lunghi.

### Fixed
- In vista tabellare Parchi il pannello tipologie EUAP non si popolava se non si era passati prima dalla mappa, e i suoi checkbox non filtravano i risultati della tabella; ora la lista si ricarica al toggle e il pannello è alimentato dal nuovo aggregato API.

## [0.3.0] - 2026-05-10
### Added
- **Sentieri REI (CAI, SDA 3–4):** import in build da GeoJSON precaricati in `datapack-dist/sentieri` (o `sentier`), senza download dall'API OSM2CAI; deduplica dello stesso `id` tra file di regioni diverse (priorità SDA più alta, poi `updated_at` più recente).
- Endpoint **`GET /api/rei-summary`** (conteggio sentieri e km totali da geometrie) e riepilogo **km sentieri (REI)** nella riga statistiche in header.

### Changed
- Tabella comuni: intestazione **Sentieri (km)** allineata al primo caricamento (`applyTheadForMode` all'avvio e `index.html`).
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
