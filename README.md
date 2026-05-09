# Comuni d'Italia — CRM

Applicazione web per la visualizzazione e ricerca dei comuni italiani con dati ufficiali ISTAT, mappa interattiva e confini amministrativi su PostGIS.

## Requisiti

- Docker Engine 24+
- Docker Compose v2
- Connessione internet al primo avvio (scarica gli shapefile da ISTAT e molti ZIP provinciali dalla demo DEMO ISTAT POS)

## Avvio rapido

```bash
cp .env.example .env
# Imposta POSTGRES_PASSWORD in .env
docker compose up -d --build
```

Il loader scarica automaticamente i confini amministrativi ISTAT (anno `ISTAT_YEAR`), dalla piattaforma **demo** le **popolazioni** comunali (POS, Età 999) e dall’Area download ISTAT lo **spreadsheet delle altitudini comunali** (DEM Ispra → min / max / media / centroide; default XLSX *Altimetria comuni* al 31/12/2021). Può richiedere alcuni minuti al primo avvio (ZIP provinciali POP + elaborazione altimetria).

Verifica completamento:
```bash
docker compose logs -f loader
# Attendi: "=== Done! Loaded 7XXX municipalities ===" e righe sulla popolazione ISTAT.
```

Apri il browser: **http://localhost:8080**

## Datapack (JSON + GeoJSON): build, import, deploy

Per **produzione** o per server senza accesso affidabile a ISTAT / IPA al momento del deploy, puoi lavorare con un *datapack*: file statici (GeoJSON + JSON + `manifest.json` con checksum) generati **una tantum** dove ti è comodo fare download ed elaborazioni, e poi importati nel Postgres di produzione senza riscaricare nulla.

La cartella tipica (es. `./datapack-dist/`, ignorata da git) contiene:

| File | Contenuto |
|---|---|
| `regions.geojson` | Regioni + geometrie |
| `provinces.geojson` | Province + geometrie |
| `municipalities.geojson` | Comuni con attributi già “app-ready” (popolazione, quota, L.131, contatti, ecc.) + geometria |
| `territorial_groups.json` | Raggruppamenti e membri (`groups` / `members`) |
| `manifest.json` | Schema `comuni-datapack-v1`, conteggi, SHA‑256 dei file e `territorial_groups_meta` (conteggi gruppi/membri, `build_id`, eventuale `reference_year_max`) |

### 1) Generare il datapack dagli scraping ISTAT (macchina di build)

```bash
# Richiede rete → eseguire dove puoi parlare con istat.it / demo POS / IPA, ecc.
# Output predefinito: ./datapack-dist (override: DATAPACK_DIR=/assoluto/o/relativo)
CREATE_ZIP=1 ./scripts/datapack_build_from_sources.sh   # ZIP opzionale solo se CREATE_ZIP=1 (vedi loader/export_datapack.sh)
```

Solo esportazione (DB già popolato dopo un loader normale):

```bash
CREATE_ZIP=0 ./scripts/datapack_export.sh
```

### 2) Import sul database di destinazione

Senza argomenti importa da **`./datapack-dist`** (rispetto alla root del progetto).  
`./scripts/datapack_import.sh` accetta inoltre:

- una **cartella** che contiene già `manifest.json` e i GeoJSON allo stesso livello (o in un’unica sottocartella);
- un **file `.zip`** del datapack: lo script esegue da solo `unzip` in una directory temporanea e poi importa (richiede `unzip` sul host);
- una **cartella senza `manifest.json`** ma con **un solo** file `.zip`: viene estratto automaticamente.

Esempi:

```bash
./scripts/datapack_import.sh                              # default: ./datapack-dist
./scripts/datapack_import.sh ./datapack-dist
./scripts/datapack_import.sh /percorso/comuni-datapack-2026.zip
./scripts/datapack_import.sh /cartella_con_un_solo_zip/
```

### 3) Deploy stack applicativo + (opzionale) import datapack

```bash
./scripts/deploy.sh
# Import datapack dopo avvio (default ./datapack-dist; oppure .zip o altra cartella):
./scripts/deploy.sh --import-datapack
./scripts/deploy.sh --import-datapack /percorso/cartella_o_file.zip
```

Gli script “collaudati” vivono nell’immagine **`loader`**:

- `/loader/export_datapack.sh` — Postgres → GeoJSON / JSON (`DATAPACK_DIR`, `CREATE_ZIP`, `ZIP_NAME`)
- `/loader/import_datapack.sh` — GeoJSON / JSON → Postgres (`DATAPACK_DIR`), con verifica SHA‑256 da `manifest.json`

Se Docker risponde con `No such file` su `/loader/export_datapack.sh`, l’immagine `loader` era vecchia: esegui `docker compose build loader` (gli script `datapack_*.sh` lo fanno automaticamente) o `docker compose build --no-cache loader` in caso di cache capziosa.

## Servizi

| Servizio | Porta | Descrizione |
|---|---|---|
| `web` | 8080 | Nginx — app HTML + proxy API |
| `api` | (interno) | Node.js + Express — REST/GeoJSON |
| `db` | (interno) | PostGIS 16 — dati geometrici |
| `loader` | — | One-shot, esce dopo il caricamento |

## API

| Endpoint | Descrizione |
|---|---|
| `GET /api/regions` | Lista regioni |
| `GET /api/regions/geojson` | Confini regionali (GeoJSON) |
| `GET /api/provinces?reg=9` | Province per regione |
| `GET /api/provinces/geojson?reg=9` | Confini provinciali |
| `GET /api/municipalities?reg=9&prov=50&q=pisa&montano_l131=1` | Lista paginata comuni (`montano_l131=1`: solo montani ex L.&nbsp;131/2025) |
| `GET /api/municipalities?has_contacts=1` | Solo comuni con almeno un contatto/fiscale valorizzato (IPA) |
| `GET /api/municipalities/geojson?prov=50` | Confini comunali (GeoJSON) |
| `GET /api/municipalities/50025` | Dettaglio comune + geometria |
| `GET /api/groups` | Elenco raggruppamenti (`?kind=`, `?q=`, `?ft=`, `?reg=&prov=`, `?bbox=minLon,minLat,maxLon,maxLat`, paginazione, `?include_expired=`) |
| `GET /api/groups/meta/kinds` | Tipi ammessi (unioni di comuni, comunità montane, …) |
| `GET /api/groups/:id` | Dettaglio + elenco comuni (id numerico o `slug`) |
| `GET /api/groups/:id/geojson` | Unione delle geometrie dei comuni del gruppo |

### Raggruppamenti territoriali (unioni di comuni, comunità montane, ecc.)

Schema: `db/init/02_territorial_groups.sql` (eseguito sul **primo bootstrap** Postgres). Aggiunge metadati su fonti e anni con:

```bash
docker compose exec -T db psql -U postgres -d comuni < db/migrations/012_territorial_groups_metadata.sql
```

Colonne chiave:

| Colonna | Uso |
|---|---|
| `slug` | Univoco stabile nell’istanza CRM (preferire prefissi geografici tipo `reg-9-<slug>` oppure chiave deriva-da-fonte `external_id`) |
| `source_name` / `source_url` | Tracciabilità open data ministeriale/regionale |
| `reference_year` | Anno statuto / anno di aggiornamento dataset |
| `external_id` | Chiave nell’origine; univoca insieme a `source_name` se valorizzati entrambi |
| `valid_from` / `valid_to` | Storicità; elenco `/api/groups` mostra solo enti vigenti salvo `?include_expired=1` |
| `is_demo` | Raggruppamenti solo dimostrativi |

**Dati demo (opzionali)** — dopo il loader comuni:

```bash
docker compose exec -T db psql -U postgres -d comuni < db/seeds/demo_territorial_groups.sql
```

**Lista API**

- `GET /api/groups?kind=&q=` — filtro tipo e LIKE su `label`/`slug`.
- `GET /api/groups?ft=` — ricerca full-text italiana su label+slug (indice GIN).
- `GET /api/groups?reg=9` o `?prov=50` — gruppi che hanno **almeno un comune membro** in quella regione/provincia.
- `GET /api/groups?bbox=minLon,minLat,maxLon,maxLat` — stesso concetto usando intersezione geometria comunale nel riquadro (SRID 4326).
- `?limit=` (max 500) e `?offset=` — paginazione.

**Datapack** — `manifest.json` include ora `territorial_groups_meta` (`schema_version`, `groups_count`, `members_count`, `build_id`, opzionale `reference_year_max`); durante l’import vengono segnalate discrepanze con i contatori del file manifest (solo WARN).

Formato interoperabile per caricamenti nazionali: file **NDJSON** o JSON **array**. Ogni elemento:

- obbligatori: `slug`, `label`, `group_kind`, `members` (array numeri `pro_com` ISTAT);
- facoltativi: `notes`, `valid_from`, `valid_to`, `source_name`, `source_url`, `reference_year`, `external_id`, `is_demo`.

Esempio in repo: [db/examples/territorial_groups_import.ndjson](db/examples/territorial_groups_import.ndjson).

```bash
docker compose run --rm -v "$(pwd)/db/examples:/samples:ro" api \
  node scripts/import_territorial_ndjson.js --file /samples/territorial_groups_import.ndjson
```

Esegui dalla **root del progetto** (`$(pwd)` risolve la cartella `db/examples` sul host).

### Import pilota Regione Toscana (Unioni di Comuni)

Fonte open data indicata nel dataset “Comuni della Toscana con funzione statistica associata per statuto al 01/01/2024”; lo script imposta anche `source_name`, `source_url`, `reference_year` e `external_id`.

```bash
docker compose up -d --build api
docker compose exec api node scripts/import_toscana_unioni.js
```

## Aggiornamento dati ISTAT

```bash
# Confini (+ popolazione, salvo SKIP_ISTAT_POP=1) per un anno geografico diverso
ISTAT_YEAR=2027 docker compose run --rm loader bash load.sh --force

# Solo aggiornare le popolazioni (confini già nel volume DB; crea colonne se mancano)
docker compose exec -T db psql -U postgres -d comuni -c \
  "ALTER TABLE municipalities ADD COLUMN IF NOT EXISTS popolazione_residente INTEGER; ALTER TABLE municipalities ADD COLUMN IF NOT EXISTS popolazione_istat_anno SMALLINT;"
docker compose run --rm loader bash -lc 'source /loader/load_popolazione.sh && load_popolazione_main'
```

Variabili utili sul servizio `loader`: `ISTAT_POP_YEAR`, `SKIP_ISTAT_POP`, `ISTAT_ALTIMETRIA_XLS_URL`, `SKIP_ISTAT_ALTIMETRIA`, `COMUNI_MONTANI_L131_PDF`, `COMUNI_MONTANI_L131_PDF_URL`, `SKIP_COMUNI_MONTANI_L131`, `CURL_INSECURE` (vedi `.env.example`).

### Contatti e dati fiscali comuni (IPA/AgID)

I campi `sito_web`, `email`, `pec`, `telefono`, `codice_fiscale`, `indirizzo_fisico` sono importabili da file CSV (cartella `data/`) e possono essere generati automaticamente dagli open data dell’IPA (Indice delle Pubbliche Amministrazioni) gestito da AgID.

1) Genera il CSV da IPA (scrive `data/contatti-comuni.csv`):

```bash
docker compose run --rm loader bash -lc 'bash /loader/build_contatti_comuni_from_ipa.sh'
```

2) Import nel database:

```bash
docker compose run --rm loader bash -lc 'source /loader/load_contatti_comuni.sh && load_contatti_comuni_main'
```

Formato CSV atteso (header obbligatorio, UTF-8):
`pro_com,sito_web,email,pec,telefono,codice_fiscale,indirizzo_fisico`

Migrazione colonne per DB già esistente: `db/migrations/011_municipalities_contacts.sql`.

### Comuni montani (L.&nbsp;131/2025)

Non esiste uno «shapefile» dedicato: l’elenco è distribuito come **PDF** tabellare. Il loader converte il PDF con `pdftohtml -xml` e abbina **sigla provinciale (nomenclatura 2025)** + **nome comune** ai record ISTAT.

- **Database nuovo** (primo `docker compose up` con `--build`): al termine dello shapefile viene eseguito automaticamente l’import (download da `COMUNI_MONTANI_L131_PDF_URL` se non indichi un file locale).
- **PDF locale**: monta la cartella `./data` (già prevista in `docker-compose`) e in `.env` imposta ad esempio `COMUNI_MONTANI_L131_PDF=/data/comuni-montani-l131.pdf`.
- **Database già popolato** (loader che esce subito senza `--force`):

```bash
docker compose run --rm loader bash -lc 'source /loader/load_comuni_montani_l131.sh && load_comuni_montani_l131_main'
```

Migrazione minimale della sola colonna (senza aggiornare i boolean): file `db/migrations/010_comune_montano_l131.sql` (non eseguito automaticamente).

Lo script crea la colonna `comune_montano_l131` se manca. In un `load.sh --force` puoi rinviare l’import PDF con `SKIP_COMUNI_MONTANI_L131=1` e lanciare poi il comando sopra separatamente.

Solo **altimetria** (dopo colonne create da `post_load.sql`):

```bash
docker compose run --rm loader bash -lc 'source /loader/load_altimetria.sh && load_altimetria_main'
```

## Deploy in produzione

Metti un reverse proxy TLS (Caddy, Nginx host, Traefik) davanti alla porta 8080.
Il traffico `web:8080` espone già sia la SPA sia le API su un'unica origin.

Cambia `WEB_PORT` in `.env` se la 8080 è già occupata.

## Sorgente dati

Confini delle unità amministrative a fini statistici — ISTAT (cartografia generalizzata)  
https://www.istat.it/it/archivio/222527  

Popolazione residente comunale — **demo** ISTAT, applicazione *Popolazione residente per sesso, età e stato civile* (`i=POS`, download provinciali ZIP)  
https://demo.istat.it/app/?i=POS&l=it  

Altitudini comunali (min / max / media / centroide, da DEM Ispra) — tabulato ISTAT *Altimetria comuni* (XLSX, default al 31/12/2021)  
https://www.istat.it/classificazione/principali-statistiche-geografiche-sui-comuni/
