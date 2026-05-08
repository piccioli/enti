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
| `GET /api/groups` | Elenco raggruppamenti (`?kind=`, `?q=`) |
| `GET /api/groups/meta/kinds` | Tipi ammessi (unioni di comuni, comunità montane, …) |
| `GET /api/groups/:id` | Dettaglio + elenco comuni (id numerico o `slug`) |
| `GET /api/groups/:id/geojson` | Unione delle geometrie dei comuni del gruppo |

### Raggruppamenti territoriali (unioni di comuni, ecc.)

Le tabelle `territorial_groups` e `territorial_group_members` sono create da `db/init/02_territorial_groups.sql`.

- **Database nuovo** (primo `docker compose up` senza volume Postgres): lo script viene eseguito automaticamente con `docker-entrypoint-initdb.d`.
- **Database già esistente** (volume `pgdata` già creato): applicare una tantum:

```bash
docker compose exec -T db psql -U postgres -d comuni < db/init/02_territorial_groups.sql
```

Poi ricostruire il servizio API se necessario: `docker compose up -d --build api web`.

### Import pilota Toscana (Unioni di Comuni)

Fonte ufficiale: Regione Toscana — dataset open data “Comuni della Toscana con funzione statistica associata per statuto al 01/01/2024”.

Import automatico (crea/aggiorna gruppi `toscana-*` e sostituisce i membri):

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
