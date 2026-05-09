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

## 4. Integrazione con i sentieri del Catasto REI

Obiettivo: arricchire il CRM dei comuni con **sentieri (hiking routes) del Catasto REI** seguendo lo **stack datapack** (snapshot dati aggiornato raramente), usando l’API OSM2CAI v2 **solo in fase di build** (spec OpenAPI: `https://osm2cai.cai.it/docs?api-docs.json`).

API OSM2CAI utili (v2):

- **Indice sentieri per area** (ritorna mappa `{id -> updated_at}`):
  - `GET /api/v2/hiking-routes/region/{region_code}/{sda}`
  - `GET /api/v2/hiking-routes/bb/{bounding_box}/{sda}`
- **GeoJSON sentiero**:
  - `GET /api/v2/hiking-route/{id}` (Feature GeoJSON con `properties.id`, `properties.relation_id`, `properties.ref`, `properties.sda`, `properties.validation_date`, ecc.)
  - `GET /api/v2/hiking-route-tdh/{id}` (Feature GeoJSON “TDH”, include `ref_REI`, `gpx_url`, ecc.)

Da fare (proposta implementativa nel repo):

- **Approccio “datapack snapshot” (no dipendenze runtime)**:
  - Durante `scripts/datapack_build_from_sources.sh` (o script dedicato), scaricare/aggiornare un *cache* dei sentieri REI e poi esportare nel datapack.
  - L’app (api/web) legge solo il contenuto nel DB generato/importato dal datapack.
  - Se serve aggiornamento “incrementale” tra due build, usare `{id -> updated_at}` come indice ma sempre dentro la build (non on-demand).

- **DB (nuove tabelle)**:
  - `rei_hiking_routes` (id osm2cai, relation_id, ref, ref_rei, sda, cai_scale, from/to, validation_date, updated_at, issues_*, source_url, geom MultiLineString).
  - Tabelle *metriche* (valori statistici calcolati in import; “km interni”):
    - `municipality_rei_stats` (pro_com, sda, km_inside, computed_at)
    - `territorial_group_rei_stats` (group_id, sda, km_inside, computed_at)
    - `protected_area_rei_stats` (protected_area_id, sda, km_inside, computed_at) *(attivabile quando §2 è implementato)*
- **Ingest/aggiornamento (durante build datapack)**:
  - Script `api/scripts/import_rei_hiking_routes.js` che:
    - prende input `--region-code` oppure `--bbox` e `--sda` (default consigliato: `sda=4` validati).
    - usa l’indice `{id -> updated_at}` per capire cosa scaricare/refreshare (cache locale tra build).
    - per ogni id scarica `hiking-route-tdh/{id}` (o `hiking-route/{id}` se basta) e upserta in `rei_hiking_routes`.
    - gestisce rate limit / retry (429/5xx) e salvataggio progressivo (checkpoint su file) per rendere la build ripetibile.
- **Associazione ai comuni**:
  - Precompute (in build): metrica principale = **km totali di sentieri in SDA=3/4 dentro a un poligono** (comune / gruppo / parco).
  - Regola: “solo interni” ⇒ se il sentiero attraversa i confini, si considera **solo la porzione** ottenuta con `ST_Intersection(poligono, sentiero)`.
  - Calcolo consigliato (PostGIS):
    - `ST_Length( ST_Intersection(area.geom, hr.geom)::geography ) / 1000.0` per avere km in WGS84 in modo robusto.
    - Aggregazione per `sda IN (3,4)` in tabelle `*_rei_stats`.
  - (Opzionale) mantenere anche una tabella di dettaglio per debug/QA:
    - `municipality_rei_hiking_routes` (pro_com, osm2cai_id, sda, km_inside, computed_at)
    - utile per verificare i sentieri che contribuiscono al totale del comune.

- **Metriche anche su raggruppamenti territoriali e parchi** (in import):
  - **Gruppi**: usare `territorial_group_members` per derivare il poligono “area gruppo” come `ST_UnaryUnion(ST_Collect(m.geom))` sui comuni membri, poi sommare i km interni dei sentieri su quell’area.
  - **Parchi**: stessa metrica su `protected_areas.geom` (quando disponibile), scrivendo su `protected_area_rei_stats`.
  - Evitare calcoli “lazy” a runtime (coerente con datapack aggiornato raramente).
- **API interna (nostra)**:
  - `GET /api/municipalities/:pro_com/rei-hiking-routes` (lista sentieri che intersecano il comune, con campi minimi + link `public_page`/`gpx_url`).
  - `GET /api/rei-hiking-routes/:id` (dettaglio / GeoJSON).
- **Datapack (parte dello stack)**:
  - Aggiungere `rei_hiking_routes.geojson` al datapack (attenzione dimensione: potenzialmente enorme; valutare export per regione o per bbox).
  - Nel `manifest.json`: entry per `rei_hiking_routes` + metadati (sda incluso, timestamp export, scope regione/bbox, versione sorgente/cutoff `updated_at`).
  - (Se si calcolano metriche in build) includere anche export “leggero” delle statistiche:
    - `municipality_rei_stats.json` (pro_com → km_inside_sda3/km_inside_sda4)
    - `territorial_group_rei_stats.json` (group_id → km_inside_sda3/km_inside_sda4)
    - `protected_area_rei_stats.json` (protected_area_id → km_inside_sda3/km_inside_sda4)
- **UI (web)**:
  - Nel popup comune: sezione “Sentieri REI” con contatore, lista filtrabile (per `sda`, `ref`, `cai_scale`) e bottone “Apri su osm2cai”.
  - Layer mappa: visualizza sentieri selezionati (o quelli del comune attivo) con stile per `sda`/`cai_scale`.

## 3. UX/UI — visibilità confini comunali

- **Stile Leaflet**: aumentare contrasto bordo vs riempimento (peso linea, colore più scuro su zoom alto); outline-only per evitare “macchia” sul territorio.
- **Zoom dipendente**: stile più marcato a zoom elevato; possibile outline tratteggiato per non coprire OSM.
- **Selezione**: stato “selected” più evidente (halo / secondo contorno) coerente con tema dark della sidebar.
- **Accessibilità**: contrasto colori secondo WCAG dove possibile.
- **Mappa di base**: Aggiungere tiles webmapp (default, 
https://api.webmapp.it/tiles/14/8640/5923.png) e aggiungere altri layer selezionabili (OSM, satellite)

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

## 7. Statistiche generali

- **Sezione statistiche**: Aggiungere pagine che diano statistiche generali sulle varie entità territoriali presenti
- **Statistiche Comuni**: Dashboard con grafici e mappe che rappresentano le principali statistiche presenti nel database relative ai comuni
- **Statistiche Raggrupamenti**: Dashboard con grafici e mappe che rappresentano le principali statistiche presenti nel database relative ai raggruppamenti territoriali
- **Statistiche Parchi e aree protette**: Dashboard con grafici e mappe che rappresentano le principali statistiche presenti nel database relative ai parchi e alle aree protette
- **Funionalità Download PDF**: tutte le singole pagine di statistiche devono avere la possibilità di scaricare la visualizzazione a schermo in formato PDF

## 8. Copyrights / Software INFO ecc.

- **Aggiungere licenza MIT**: includere il testo della licenza MIT del software nel repository e renderla consultabile dall’app.
- **CTA “Info software”**: aggiungere una CTA in footer/header che apra un popup/modal con le informazioni del software.
- **Versionamento**: definire e visualizzare la versione del software con schema a tre livelli \(major.minor.patch\) (SemVer).
- **Prima release**: creare il primo rilascio ufficiale del software (versione iniziale e note di rilascio).
- **Changelog**: introdurre e mantenere un `CHANGELOG.md` (formato tipo “Keep a Changelog”) e collegarlo dalle “Info software” (link “Changelog” o note dell’ultima release).
- **Info nel popup**: nel popup “Info software” mostrare almeno licenza, versione attuale e link a eventuali note di rilascio.
- **Variabile di ambiente**: aggiungere/mostrare un indicatore dell’ambiente attivo (es. `DEV` / `PROD`) nelle “Info software”.


---

*Ultimo aggiornamento: note di progetto interne.*