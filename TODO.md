# TODO — idee e miglioramenti

Note operative da tenere in backlog (priorità non definita).

## 1. Dati — enti territoriali e aggregazioni comuni (Italia)

*Implementazioni base nel repo*: metadati su `territorial_groups` (`source_name`, `source_url`, `reference_year`, `external_id`, `is_demo`), datapack `territorial_groups_meta` nel `manifest`, filtri `GET /api/groups` geografici (`reg`, `prov`, `bbox`) + full-text `ft`, filtro vigenti con `include_expired`, paginazione, seed demo in `db/seeds/`, import NDJSON pilota (`import_territorial_ndjson.js`) e aggiornamento import Toscana con fonte anno.

Da fare per scala nazionale omogenea:

- **Dataset per ogni tipo** (`group_kind`): scegliere una fonte primaria Italia o pipeline regionale ripetibile.
- **Convenzione slug** da applicare in produzione quando si combinano più fonti (`reg-{cod}-{chiave}`, prefisso IPA, ecc.).
- **Import batch** esterni (non solo NDJSON pilota): validazione slug duplicati prima dell’UPSERT massivo.

## 2. Dati — parchi e aree protette

- **Fonti**: Incorporare dataset istituzionali (es. repertorio aree protette / EUAP — verificare licenza e aggiornamento periodico).
- **Schema**: nuova tabella `protected_areas` (codice, nome, tipologia, geometria MultiPolygon) + eventuale tabella di associazione `municipality_protected_area` (intersezione o centoroide nel parco).
- **Loader**: script dedicato (shapefile/GeoJSON → PostGIS) e inclusione nel datapack come layer separato (`protected_areas.geojson`).
- **Mappe**: layer toggle “parchi” con opacità e ordine z-index sotto ai confini comunali se serve leggibilità.

## 3. UX/UI — visibilità confini comunali

- **Stile Leaflet**: aumentare contrasto bordo vs riempimento (peso linea, colore più scuro su zoom alto); outline-only per evitare “macchia” sul territorio.
- **Zoom dipendente**: stile più marcato a zoom elevato; possibile outline tratteggiato per non coprire OSM.
- **Selezione**: stato “selected” più evidente (halo / secondo contorno) coerente con tema dark della sidebar.
- **Accessibilità**: contrasto colori secondo WCAG dove possibile.

## 4. Vista JSON — export CRM nel popup comune

- **Popup**: pulsante “Copia JSON” o pannello espandibile con `JSON.stringify(feature.properties, …)` formattato (indentazione).
- **Payload**: includere chiavi già esposte dall’API (`GET /api/municipalities/:procom`) coerenti con export bulk futuro.
- **Privacy**: non esporre dati sensibili non necessari; eventuale toggle “solo campi pubblici”.

## 5. Viste tabellari — enti (comuni / aggregazioni / parchi)

- **Navigazione**: tab o sezioni dedicate nella sidebar o pagine route-light (`#comuni`, `#gruppi`, `#parchi`) senza SPA pesante.
- **Comuni**: tabella esistente → ordinamento colonne, colonne configurabili, sticky header.
- **Aggregazioni**: tabella gruppi con tipo, n° comuni, link “dettaglio” / zoom mappa (già parzialmente presente).
- **Parchi** (post-dati §2): tabella con nome, tipo, regioni/province toccate, azioni “zoom” / “dettaglio”.
- **Responsive**: layout scroll orizzontale controllato su mobile (già affrontato per colonne stretta).

## 6. Download XLS

- **Export tabella corrente**: da vista lista comuni filtrata → XLSX (SheetJS o generazione server-side con `exceljs` / CSV+XLS conversion).
- **Export selezione**: righe selezionate con checkbox → file unico con colonne allineate al datapack “business”.
- **Backend opzionale**: `GET /api/municipalities/export.xlsx?…` con limiti e rate-limit per evitare abusi.
- **Naming**: nome file con timestamp e filtri applicati (es. `comuni_reg9_2026.xlsx`).

---

*Ultimo aggiornamento: note di progetto interne.*