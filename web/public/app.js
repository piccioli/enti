/* globals L */
'use strict';

const API = '';
const PAGE_SIZE = 50;

const state = {
  reg: null,
  prov: null,
  group: null,
  q: '',
  page: 0,
  total: 0,
  selectedProCom: null,
  /** 'comuni' | 'parchi' */
  searchMode: 'comuni',
  selectedProtectedId: null,
  /** Tipologia EUAP → visibile (`false` = nascosta dalla mappa). Chiave assente = visibile. */
  parkTypeChecked: {},
};

// ── DOM refs ─────────────────────────────────────────────────────────────────
const selReg       = document.getElementById('sel-reg');
const selProv      = document.getElementById('sel-prov');
const filterRowProv = document.getElementById('filter-row-prov');
const searchInput  = document.getElementById('search-input');
const btnReset     = document.getElementById('btn-reset');
const chkMontanoL131 = document.getElementById('chk-montano-l131');
const chkHasContacts = document.getElementById('chk-has-contacts');
const chkWithRei = document.getElementById('chk-with-rei');
function chkAllEl() {
  return document.getElementById('chk-all');
}
const selCountEl   = document.getElementById('sel-count');
const btnExportPng = document.getElementById('btn-export-png');
const btnExportPdf = document.getElementById('btn-export-pdf');
const tbody        = document.getElementById('tbody');
const resultCount  = document.getElementById('result-count');
const resultHint   = document.getElementById('result-hint');
const emptyState   = document.getElementById('empty-state');
const paginationEl = document.getElementById('pagination');
const statsEl      = document.getElementById('stats');
const loadingEl    = document.getElementById('loading');
const loadingMsg   = document.getElementById('loading-msg');
const dbDot        = document.getElementById('db-dot');
const dbLabel      = document.getElementById('db-label');
const selGroupKind = document.getElementById('sel-group-kind');
const selGroup     = document.getElementById('sel-group');
const groupDetail  = document.getElementById('group-detail');
const theadMain = document.getElementById('thead-main');
const btnSearchComuni = document.getElementById('btn-search-comuni');
const btnSearchParchi = document.getElementById('btn-search-parchi');
const parkTypePanel = document.getElementById('park-type-panel');
const parkTypeList = document.getElementById('park-type-list');
const btnParkTypesAll = document.getElementById('btn-park-types-all');

const btnSoftwareInfo = document.getElementById('btn-software-info');
const softwareModal = document.getElementById('software-modal');
const swVersionEl = document.getElementById('sw-version');
const swEnvEl = document.getElementById('sw-env');
const swMetaErrorEl = document.getElementById('sw-meta-error');

const selected = new Set(); // pro_com selezionati (export)

// ── Software info modal ───────────────────────────────────────────────────────
let softwareMetaCache = null;

function modalOpen() {
  if (!softwareModal) return;
  softwareModal.classList.remove('hidden');
  softwareModal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function modalClose() {
  if (!softwareModal) return;
  softwareModal.classList.add('hidden');
  softwareModal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

async function loadSoftwareMetaOnce() {
  if (softwareMetaCache) return softwareMetaCache;
  if (swMetaErrorEl) swMetaErrorEl.classList.add('hidden');
  try {
    softwareMetaCache = await apiFetch('/api/meta');
    return softwareMetaCache;
  } catch (e) {
    console.warn('Failed to load /api/meta', e);
    if (swMetaErrorEl) swMetaErrorEl.classList.remove('hidden');
    return null;
  }
}

async function openSoftwareInfo() {
  modalOpen();
  const meta = await loadSoftwareMetaOnce();
  if (meta && swVersionEl) swVersionEl.textContent = meta.version || '—';
  if (meta && swEnvEl) swEnvEl.textContent = meta.env || '—';
}

// ── Map ──────────────────────────────────────────────────────────────────────
const map = L.map('map', { zoomControl: true }).setView([42.5, 12.5], 6);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 18,
  crossOrigin: true,
}).addTo(map);

const style = {
  region:       { color: '#3b82f6', weight: 1.5, fillColor: '#3b82f6', fillOpacity: 0.06 },
  /** Vista Parchi: solo confini regionali, senza riempimento (no click). */
  regionOutline: {
    color: '#64748b',
    weight: 1.25,
    fillOpacity: 0,
    opacity: 0.9,
    lineJoin: 'round',
  },
  province:     { color: '#8b5cf6', weight: 1.5, fillColor: '#8b5cf6', fillOpacity: 0.08 },
  municipality: { color: '#06b6d4', weight: 1,   fillColor: '#06b6d4', fillOpacity: 0.10 },
  /** Layer parchi (sotto i comuni quando entrambi attivi — qui sostituisce il layer comunale in modalità Parchi). */
  protectedArea: {
    color: '#15803d',
    weight: 1,
    opacity: 0.9,
    fillColor: '#22c55e',
    fillOpacity: 0.2,
    lineJoin: 'round',
  },
  // Layer evidenziato: comuni appartenenti al raggruppamento selezionato
  municipalityGroup: {
    color: '#16a34a',
    weight: 3.5,
    opacity: 0.95,
    fillColor: '#22c55e',
    fillOpacity: 0.30,
    lineJoin: 'round',
    lineCap: 'round',
  },
  selected:     { color: '#f59e0b', weight: 2.5, fillColor: '#f59e0b', fillOpacity: 0.25 },
  grouping:     { color: '#eab308', weight: 2.2, fillColor: '#eab308', fillOpacity: 0.14 },
};

let regionsLayer     = null;
let provincesLayer   = null;
let municipalsLayer  = null;
let highlightLayer   = null;
/** GeoJSON completo delle regioni (per filtrare il layer senza nuove richieste). */
let regionsGeoCache   = null;
/** GeoJSON delle province della regione selezionata (`state.reg`). */
let provincesGeoCache = null;
let groupingLayer     = null;
let protectedAreasLayer = null;
/** Ultimo GeoJSON aree protette caricato (per filtri tipologia senza nuova richiesta). */
let protectedAreasGeoCache = null;

/** Ordine elenco pannello tipologie (il resto in coda, alfabetico; senza tipologia per ultima). */
const PARK_TYPE_ORDER = ['PNZ', 'PNZ_m', 'PNR', 'RNS', 'RNR', 'GAPN', 'AANP', 'MAR'];

/** Sigla EUAP → nome descrittivo e colore riempimento mappa (stroke derivato). */
const PARK_TYPE_META = {
  PNZ: { name: 'Parco nazionale (terrestre)', color: '#166534' },
  PNZ_m: { name: 'Parco nazionale marino', color: '#0f766e' },
  PNR: { name: 'Parco naturale regionale', color: '#1d4ed8' },
  RNS: { name: 'Riserva naturale statale', color: '#b91c1c' },
  RNR: { name: 'Riserva naturale regionale', color: '#ea580c' },
  GAPN: { name: 'Area protetta nazionale (es. sottomarina)', color: '#7c3aed' },
  AANP: { name: 'Altra area naturale protetta', color: '#c026d3' },
  MAR: { name: 'Area marina protetta / riserva marina', color: '#0369a1' },
  '': { name: '(Senza tipologia)', color: '#64748b' },
};

function metaForParkType(code) {
  const k = code === undefined || code === null ? '' : String(code).trim();
  if (Object.prototype.hasOwnProperty.call(PARK_TYPE_META, k)) return PARK_TYPE_META[k];
  if (!k) return PARK_TYPE_META[''];
  return { name: `Tipologia ${k}`, color: fallbackParkColor(k) };
}

function fallbackParkColor(code) {
  const fb = ['#f43f5e', '#8b5cf6', '#06b6d4', '#eab308', '#fb7185', '#34d399', '#f97316'];
  let h = 0;
  const s = String(code || '?');
  for (let i = 0; i < s.length; i++) h += s.charCodeAt(i);
  return fb[h % fb.length];
}

function parkTypeKey(props) {
  const t = props && props.area_type;
  if (t == null || String(t).trim() === '') return '';
  return String(t).trim();
}

function darkenStroke(fillHex) {
  try {
    const n = fillHex.replace('#', '');
    const hex = n.length === 3
      ? n.split('').map((c) => c + c).join('')
      : n;
    const num = parseInt(hex, 16);
    const factor = 0.52;
    const r = Math.round(((num >> 16) & 255) * factor);
    const g = Math.round(((num >> 8) & 255) * factor);
    const b = Math.round((num & 255) * factor);
    return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
  } catch {
    return '#0f172a';
  }
}

function protectedAreaStyleForFeature(feature) {
  const k = parkTypeKey(feature.properties);
  const meta = metaForParkType(k);
  const fill = meta.color;
  return {
    color: darkenStroke(fill),
    fillColor: fill,
    weight: 1.25,
    opacity: 0.92,
    fillOpacity: 0.32,
    lineJoin: 'round',
  };
}

function countParkTypesInGeojson(fc) {
  const m = {};
  for (const f of fc.features || []) {
    const k = parkTypeKey(f.properties);
    m[k] = (m[k] || 0) + 1;
  }
  return m;
}

function parkTypeDataAttr(code) {
  return code === '' ? '__empty__' : code;
}

function parseParkTypeDataAttr(raw) {
  return raw === '__empty__' ? '' : String(raw || '');
}

function escAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function syncParkTypePanelFromGeojson(fc) {
  const counts = countParkTypesInGeojson(fc);
  for (const k of Object.keys(counts)) {
    if (!Object.prototype.hasOwnProperty.call(state.parkTypeChecked, k)) {
      state.parkTypeChecked[k] = true;
    }
  }
  renderParkTypePanel(counts);
}

function compareParkTypePanelEntries(a, b) {
  const ka = a[0];
  const kb = b[0];
  const ia = PARK_TYPE_ORDER.indexOf(ka);
  const ib = PARK_TYPE_ORDER.indexOf(kb);
  if (ia !== -1 && ib !== -1) return ia - ib;
  if (ia !== -1) return -1;
  if (ib !== -1) return 1;
  if (ka === '' && kb === '') return 0;
  if (ka === '') return 1;
  if (kb === '') return -1;
  return ka.localeCompare(kb, 'it');
}

function renderParkTypePanel(counts) {
  if (!parkTypeList) return;
  const entries = Object.entries(counts).sort(compareParkTypePanelEntries);
  if (!entries.length) {
    parkTypeList.innerHTML = '<p class="park-type-empty">Nessuna area in questo ambito.</p>';
    return;
  }
  const parts = [];
  for (const [code, n] of entries) {
    const meta = metaForParkType(code);
    const checked = state.parkTypeChecked[code] !== false;
    const sigla = code ? esc(code) : '—';
    const dt = parkTypeDataAttr(code);
    parts.push(
      `<label class="park-type-row" data-park-type="${escAttr(dt)}">` +
        `<span class="park-type-swatch" style="background:${esc(meta.color)}"></span>` +
        `<div class="park-type-main">` +
          `<div class="park-type-sigla">${sigla}</div>` +
          `<div class="park-type-name">${esc(meta.name)}</div>` +
        `</div>` +
        `<span class="park-type-count">${Number(n).toLocaleString('it-IT')}</span>` +
        `<input type="checkbox" ${checked ? 'checked' : ''} aria-label="Mostra tipologia ${sigla} sulla mappa" />` +
      `</label>`
    );
  }
  parkTypeList.innerHTML = parts.join('');
}

function rebuildProtectedAreasLayer() {
  protectedAreasLayer = clearLayer(protectedAreasLayer);
  if (!protectedAreasGeoCache || state.searchMode !== 'parchi') return;
  const feats = (protectedAreasGeoCache.features || []).filter((f) => {
    const k = parkTypeKey(f.properties);
    return state.parkTypeChecked[k] !== false;
  });
  if (!feats.length) return;
  const fc = { type: 'FeatureCollection', features: feats };
  protectedAreasLayer = L.geoJSON(fc, {
    style: protectedAreaStyleForFeature,
    onEachFeature: (feat, lyr) => {
      lyr.on('click', () => onProtectedAreaMapClick(feat.properties));
    },
  }).addTo(map);
  if (protectedAreasLayer.bringToFront) protectedAreasLayer.bringToFront();
}

function clearParkHighlightIfHidden() {
  if (state.selectedProtectedId == null || !protectedAreasGeoCache) return;
  const feat = protectedAreasGeoCache.features.find(
    (f) => f.properties.id === state.selectedProtectedId
  );
  if (!feat) return;
  const k = parkTypeKey(feat.properties);
  if (state.parkTypeChecked[k] === false) {
    highlightLayer = clearLayer(highlightLayer);
    state.selectedProtectedId = null;
    document.querySelectorAll('#tbody tr.selected').forEach((tr) => tr.classList.remove('selected'));
  }
}

function visibleParkFeaturesForBounds(gj) {
  return (gj.features || []).filter((f) => {
    const k = parkTypeKey(f.properties);
    return state.parkTypeChecked[k] !== false;
  });
}

const THEAD_COMUNI_ROW = `
  <tr>
    <th class="col-check"><input id="chk-all" type="checkbox" aria-label="Seleziona tutti" /></th>
    <th>Comune</th>
    <th>Prov</th>
    <th>Regione</th>
    <th class="num">Abitanti</th>
    <th class="num" title="Quota media sul territorio (m s.l.m., ISTAT–DEM Ispra). Passa sul valore per min/max.">Quota</th>
    <th class="num col-l131" title="Comune montano ai sensi della L. 131/2025 (elenco ministeriale)">L.&nbsp;131</th>
    <th class="col-pec" title="PEC presente (dati open data IPA/AgID)">PEC</th>
    <th class="col-info" title="Almeno un contatto/CF/indirizzo valorizzato (IPA)">Info</th>
    <th class="num" title="Km totali sentieri CAI (SDA 3+4) dentro al comune">Sentieri (km)</th>
    <th>Cod. ISTAT</th>
  </tr>`;

const THEAD_PARCHI_ROW = `
  <tr>
    <th>Area protetta</th>
    <th>Tipologia</th>
    <th>Codice</th>
    <th class="num">Superficie</th>
    <th class="num" title="Km totali sentieri CAI (SDA 3+4) dentro al parco">Sentieri (km)</th>
    <th class="num">ID</th>
  </tr>`;

function clearLayer(ref) { if (ref) map.removeLayer(ref); return null; }

function featCodReg(f) {
  const cr = f.properties.cod_reg;
  return typeof cr === 'number' ? cr : parseInt(String(cr), 10);
}

function featCodProv(f) {
  const cp = f.properties.cod_prov;
  return typeof cp === 'number' ? cp : parseInt(String(cp), 10);
}

/** Comuni: tutte le regioni o solo quella selezionata (poligoni colorati, click).
 *  Parchi: sempre tutti i confini regionali, solo contorno, mai interattivi (i click vanno agli EUAP).
 */
function renderRegionsLayer() {
  regionsLayer = clearLayer(regionsLayer);
  if (!regionsGeoCache) return;
  const all = regionsGeoCache.features || [];
  if (state.searchMode === 'parchi') {
    const collection = { type: 'FeatureCollection', features: all };
    regionsLayer = L.geoJSON(collection, {
      style: () => style.regionOutline,
      interactive: false,
    }).addTo(map);
    return;
  }
  const features = state.reg == null
    ? all
    : all.filter((f) => featCodReg(f) === state.reg);
  const collection = { type: 'FeatureCollection', features };
  regionsLayer = L.geoJSON(collection, {
    style: () => style.region,
    interactive: true,
    onEachFeature: (feat, layer) => {
      layer.on('click', () => onRegionClick(feat.properties));
    },
  }).addTo(map);
}

/** Province della regione corrente: tutte se `state.prov` è null, altrimenti solo quella selezionata. In modalità Parchi non si disegnano. */
function renderProvincesLayer() {
  provincesLayer = clearLayer(provincesLayer);
  if (state.searchMode === 'parchi') return;
  if (!provincesGeoCache || state.reg == null) return;
  const all = provincesGeoCache.features || [];
  const features = state.prov == null
    ? all
    : all.filter((f) => featCodProv(f) === state.prov);
  if (!features.length) return;
  const collection = { type: 'FeatureCollection', features };
  provincesLayer = makeGeoLayer(collection, style.province, onProvinceClick).addTo(map);
}

function makeGeoLayer(geojson, layerStyle, onClick) {
  return L.geoJSON(geojson, {
    style: () => layerStyle,
    onEachFeature: (feat, layer) => {
      if (onClick) layer.on('click', () => onClick(feat.properties));
    },
  });
}

// ── API helpers ──────────────────────────────────────────────────────────────
async function apiFetch(path) {
  const res = await fetch(API + path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function applyTheadForMode() {
  if (!theadMain) return;
  theadMain.innerHTML = state.searchMode === 'comuni' ? THEAD_COMUNI_ROW : THEAD_PARCHI_ROW;
}

function applySearchModeChrome() {
  const isCom = state.searchMode === 'comuni';
  searchInput.placeholder = isCom ? 'Cerca comune...' : 'Cerca area protetta…';
  if (btnSearchComuni && btnSearchParchi) {
    btnSearchComuni.classList.toggle('segment-active', isCom);
    btnSearchParchi.classList.toggle('segment-active', !isCom);
    btnSearchComuni.setAttribute('aria-pressed', isCom ? 'true' : 'false');
    btnSearchParchi.setAttribute('aria-pressed', !isCom ? 'true' : 'false');
  }
  if (chkMontanoL131 && chkMontanoL131.closest('.filter-row')) {
    chkMontanoL131.closest('.filter-row').classList.toggle('hidden', !isCom);
  }
  if (chkHasContacts && chkHasContacts.closest('.filter-row')) {
    chkHasContacts.closest('.filter-row').classList.toggle('hidden', !isCom);
  }
  selGroup.disabled = !isCom;
  selGroupKind.disabled = !isCom;
  const exBar = document.getElementById('export-bar');
  if (exBar) exBar.classList.toggle('hidden', !isCom);
  if (filterRowProv) filterRowProv.classList.toggle('hidden', !isCom);
  if (parkTypePanel) parkTypePanel.classList.toggle('hidden', isCom);
}

async function refreshAdministrativeAreas() {
  municipalsLayer = clearLayer(municipalsLayer);
  protectedAreasLayer = clearLayer(protectedAreasLayer);
  highlightLayer = clearLayer(highlightLayer);
  state.selectedProCom = null;
  state.selectedProtectedId = null;

  if (state.searchMode !== 'parchi') {
    protectedAreasGeoCache = null;
    if (parkTypeList) parkTypeList.innerHTML = '';
  }

  if (state.group) {
    return;
  }

  try {
    if (state.searchMode === 'comuni') {
      if (state.prov) {
        const geoM = await apiFetch(`/api/municipalities/geojson?prov=${state.prov}`);
        municipalsLayer = makeGeoLayer(geoM, style.municipality, onMunicipalityMapClick).addTo(map);
        if (provincesLayer && provincesLayer.getBounds().isValid()) {
          map.fitBounds(provincesLayer.getBounds(), { padding: [28, 28] });
        }
      } else if (state.reg && provincesLayer && provincesLayer.getBounds().isValid()) {
        map.fitBounds(provincesLayer.getBounds(), { padding: [30, 30] });
      }
      return;
    }

    const gjUrl = state.reg
      ? `/api/protected-areas/geojson?reg=${state.reg}`
      : '/api/protected-areas/geojson';
    const gj = await apiFetch(gjUrl);
    protectedAreasGeoCache = gj;
    syncParkTypePanelFromGeojson(gj);
    rebuildProtectedAreasLayer();

    const visibleFeats = visibleParkFeaturesForBounds(gj);
    if (visibleFeats.length) {
      const tmpBounds = L.geoJSON({ type: 'FeatureCollection', features: visibleFeats });
      if (tmpBounds.getBounds().isValid()) {
        map.fitBounds(tmpBounds.getBounds(), {
          padding: [20, 20],
          maxZoom: state.reg ? 12 : 8,
        });
      }
    } else if (regionsLayer && regionsLayer.getBounds().isValid()) {
      map.fitBounds(regionsLayer.getBounds(), { padding: [28, 28], maxZoom: 8 });
    }
  } catch (e) {
    console.warn('refreshAdministrativeAreas:', e);
  }
}

async function setSearchMode(mode) {
  const next = mode === 'parchi' ? 'parchi' : 'comuni';
  if (state.searchMode === next) return;
  state.searchMode = next;
  state.page = 0;
  state.selectedProCom = null;
  state.selectedProtectedId = null;
  highlightLayer = clearLayer(highlightLayer);

  if (next === 'parchi') {
    state.group = null;
    selGroup.value = '';
    groupingLayer = clearLayer(groupingLayer);
    resetGroupDetailEmpty();
    clearSelection();
    state.prov = null;
    if (selProv) selProv.value = '';
    provincesLayer = clearLayer(provincesLayer);
  }

  applyTheadForMode();
  applySearchModeChrome();
  renderRegionsLayer();
  if (next === 'comuni' && state.reg && provincesGeoCache) {
    renderProvincesLayer();
  }
  await refreshAdministrativeAreas();
  await loadMainList();
}

async function loadMainList() {
  if (state.searchMode === 'comuni') await loadMunicipalities();
  else await loadProtectedAreas();
}

async function loadProtectedAreas() {
  const DEFAULT_EMPTY_MSG = 'Nessun risultato in elenco.';
  emptyState.textContent = DEFAULT_EMPTY_MSG;

  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(state.page * PAGE_SIZE),
  });
  if (state.reg) params.set('reg', state.reg);
  if (state.q) params.set('q', state.q);
  if (chkWithRei && chkWithRei.checked) params.set('with_rei', '1');

  try {
    const data = await apiFetch(`/api/protected-areas?${params}`);
    state.total = data.total;
    renderTableProtected(data.items || []);
    renderPagination();
    resultCount.textContent = `${state.total.toLocaleString('it-IT')} aree protette`;
    resultHint.textContent = state.reg
      ? ''
      : 'Mappa: tutte le aree protette. Filtra per regione dal menu per restringere elenco e zoom.';
    emptyState.classList.toggle('hidden', data.items.length > 0);
  } catch (e) {
    console.warn('Liste aree protette non disponibili:', e);
    state.total = 0;
    tbody.innerHTML = '';
    renderPagination();
    resultCount.textContent = '—';
    resultHint.textContent = 'Tabella «aree protette» non presente sul database — applicare migrazione 013';
    emptyState.textContent =
      'Dati non disponibili (migrazione `db/migrations/013_protected_areas.sql` o dataset non importato).';
    emptyState.classList.remove('hidden');
  }
}

function renderTableProtected(items) {
  emptyState.classList.toggle('hidden', items.length > 0);
  tbody.innerHTML = '';

  items.forEach((row) => {
    const tr = document.createElement('tr');
    tr.dataset.protectedId = String(row.id);
    if (row.id === state.selectedProtectedId) tr.classList.add('selected');

    const km =
      row.area_km2 != null && Number.isFinite(parseFloat(row.area_km2))
        ? parseFloat(row.area_km2).toFixed(1)
        : '—';
    const kmSentieri = parseFloat(row.km_sentieri_total);
    const kmSentieriTxt = Number.isFinite(kmSentieri) && kmSentieri > 0
      ? kmSentieri.toFixed(1)
      : '—';

    tr.innerHTML = `
      <td class="comune" title="${esc(row.name)}">${esc(row.name)}</td>
      <td>${esc(row.area_type || '—')}</td>
      <td class="code">${esc(row.external_code || '—')}</td>
      <td class="num">${km}</td>
      <td class="num">${kmSentieriTxt}</td>
      <td class="num">${row.id}</td>
    `;
    tr.addEventListener('click', () => {
      selectProtectedArea(row.id);
    });
    tbody.appendChild(tr);
  });
}

async function selectProtectedArea(id) {
  state.selectedProtectedId = id;
  state.selectedProCom = null;

  document.querySelectorAll('#tbody tr').forEach((tr) => tr.classList.remove('selected'));
  const row = tbody.querySelector(`tr[data-protected-id="${String(id)}"]`);
  if (row) {
    row.classList.add('selected');
    row.scrollIntoView({ block: 'nearest' });
  }

  highlightLayer = clearLayer(highlightLayer);
  try {
    const feat = await apiFetch(`/api/protected-areas/${id}`);
    highlightLayer = L.geoJSON(feat, { style: () => style.selected }).addTo(map);
    if (highlightLayer.getBounds().isValid()) {
      map.fitBounds(highlightLayer.getBounds(), { maxZoom: 12, padding: [40, 40] });
    }
    const p = feat.properties;
    const areaTxt =
      p.area_km2 != null && Number.isFinite(parseFloat(p.area_km2))
        ? `${parseFloat(p.area_km2).toFixed(1)} km²`
        : '—';
    const kmSentieriParco = parseFloat(p.km_sentieri_total);
    L.popup()
      .setLatLng(highlightLayer.getBounds().getCenter())
      .setContent(`
        <strong>${esc(p.name)}</strong>
        ${p.area_type ? `<br><span class="meta">${esc(p.area_type)}</span>` : ''}
        <div class="meta">
          Codice: <code>${esc(p.external_code || '—')}</code><br>
          Superficie: ${areaTxt}
          ${(Number.isFinite(kmSentieriParco) && kmSentieriParco > 0) ? `<br>Sentieri CAI: ${kmSentieriParco.toFixed(1)} km <span style="color:#64748b;font-size:11px">(SDA3: ${parseFloat(p.km_sentieri_sda3 || 0).toFixed(1)} · SDA4: ${parseFloat(p.km_sentieri_sda4 || 0).toFixed(1)})</span>` : ''}
          ${p.source_name ? `<br>Sorgente: ${esc(p.source_name)}` : ''}
        </div>
      `)
      .openOn(map);
  } catch (e) {
    console.error(e);
  }
}

function onProtectedAreaMapClick(props) {
  if (props && props.id != null) {
    void selectProtectedArea(props.id);
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  showLoading('Connessione al database...');
  try {
    await fetch('/healthz');
    dbDot.classList.remove('loading');
    dbLabel.textContent = 'DB connesso';
  } catch {
    dbDot.classList.replace('loading', 'error');
    dbLabel.textContent = 'DB non raggiungibile';
  }

  showLoading('Caricamento regioni...');
  const regions = await apiFetch('/api/regions');
  regions.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r.cod_reg;
    opt.textContent = r.den_reg;
    selReg.appendChild(opt);
  });

  showLoading('Caricamento confini regionali...');
  regionsGeoCache = await apiFetch('/api/regions/geojson');
  renderRegionsLayer();

  const [total, paHead] = await Promise.all([
    apiFetch('/api/municipalities?limit=1&offset=0'),
    apiFetch('/api/protected-areas?limit=1&offset=0').catch(() => null),
  ]);
  const comuniTxt = `${total.total.toLocaleString('it-IT')} comuni totali`;
  if (paHead && typeof paHead.total === 'number') {
    statsEl.textContent =
      `${comuniTxt} · ${paHead.total.toLocaleString('it-IT')} parchi e aree protette`;
  } else {
    statsEl.textContent = comuniTxt;
  }

  try {
    await loadGroupKinds();
    await loadGroupsList();
  } catch (e) {
    console.warn('Raggruppamenti non caricati (migrazione DB applicata?)', e);
    groupDetail.textContent =
      'Raggruppamenti non disponibili: applicare db/init/02_territorial_groups.sql sul database.';
    groupDetail.classList.remove('empty');
  }

  hideLoading();
  applySearchModeChrome();
  if (btnSearchComuni) btnSearchComuni.addEventListener('click', () => void setSearchMode('comuni'));
  if (btnSearchParchi) btnSearchParchi.addEventListener('click', () => void setSearchMode('parchi'));
  await loadMainList();
  updateSelectedUI();
}

async function loadGroupKinds() {
  const kinds = await apiFetch('/api/groups/meta/kinds');
  selGroupKind.innerHTML = '<option value="">Tutti i tipi</option>';
  kinds.forEach((k) => {
    const opt = document.createElement('option');
    opt.value = k.id;
    opt.textContent = k.label;
    selGroupKind.appendChild(opt);
  });
}

async function loadGroupsList() {
  const kind = selGroupKind.value;
  const qs = kind ? `?kind=${encodeURIComponent(kind)}` : '';
  const list = await apiFetch(`/api/groups${qs}`);
  const prev = selGroup.value;
  selGroup.innerHTML = '<option value="">— Nessuno —</option>';
  list.forEach((g) => {
    const opt = document.createElement('option');
    opt.value = String(g.id);
    opt.textContent = `${g.kind_label}: ${g.label}`;
    opt.title = g.slug;
    selGroup.appendChild(opt);
  });
  if (prev && [...selGroup.options].some((o) => o.value === prev)) {
    selGroup.value = prev;
  }
}

function resetGroupDetailEmpty() {
  groupDetail.classList.add('empty');
  groupDetail.textContent = 'Seleziona un raggruppamento per visualizzarlo in mappa.';
}

async function applySelectedGroup() {
  if (state.searchMode !== 'comuni') {
    return;
  }
  groupingLayer = clearLayer(groupingLayer);
  municipalsLayer = clearLayer(municipalsLayer);
  highlightLayer = clearLayer(highlightLayer);
  protectedAreasLayer = clearLayer(protectedAreasLayer);
  const gid = selGroup.value;
  if (!gid) {
    state.group = null;
    resetGroupDetailEmpty();
    state.page = 0;
    clearSelection();
    await refreshAdministrativeAreas();
    await loadMainList();
    return;
  }
  try {
    state.group = parseInt(gid, 10);
    state.page = 0;
    clearSelection();
    const [feat, detail, membersGeo] = await Promise.all([
      apiFetch(`/api/groups/${gid}/geojson`),
      apiFetch(`/api/groups/${gid}`),
      apiFetch(`/api/groups/${gid}/municipalities/geojson`),
    ]);
    groupDetail.classList.remove('empty');
    const area = typeof detail.area_km2 === 'number' ? detail.area_km2 : parseFloat(detail.area_km2 || '0');
    const areaTxt = Number.isFinite(area) && area > 0
      ? ` · ${area.toLocaleString('it-IT', { maximumFractionDigits: 1 })} km²`
      : '';
    groupDetail.innerHTML =
      `<strong>${esc(detail.label)}</strong> · ${esc(detail.kind_label)} · ` +
      `${detail.member_count} comuni` +
      areaTxt;

    if (feat && feat.geometry) {
      groupingLayer = L.geoJSON(feat, {
        style: () => style.grouping,
        interactive: false, // evita che il poligono del raggruppamento “mangi” i click sui comuni
      }).addTo(map);
    }

    if (membersGeo && Array.isArray(membersGeo.features) && membersGeo.features.length) {
      municipalsLayer = makeGeoLayer(membersGeo, style.municipalityGroup, onMunicipalityMapClick).addTo(map);
      municipalsLayer.eachLayer((l) => l.bringToFront());
    }

    if (groupingLayer) {
      groupingLayer.eachLayer((l) => l.bringToBack());
      const target = municipalsLayer && municipalsLayer.getBounds().isValid()
        ? municipalsLayer
        : groupingLayer;
      if (target.getBounds().isValid()) {
        map.fitBounds(target.getBounds(), { padding: [32, 32] });
      }
    } else {
      groupDetail.innerHTML +=
        '<br><em>Geometria non disponibile (nessun comune associato).</em>';
    }
    await loadMainList();
  } catch (e) {
    console.error(e);
    groupDetail.classList.remove('empty');
    groupDetail.textContent = 'Impossibile caricare il raggruppamento.';
  }
}

function showLoading(msg) {
  loadingMsg.textContent = msg;
  loadingEl.classList.remove('hidden');
}
function hideLoading() { loadingEl.classList.add('hidden'); }

// ── Events ───────────────────────────────────────────────────────────────────
if (btnSoftwareInfo && softwareModal) {
  btnSoftwareInfo.addEventListener('click', openSoftwareInfo);
  softwareModal.addEventListener('click', (e) => {
    const t = e.target;
    if (!t) return;
    if (t && t.getAttribute && t.getAttribute('data-close-modal') === '1') {
      modalClose();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!softwareModal.classList.contains('hidden')) modalClose();
  });
}

selReg.addEventListener('change', async () => {
  state.reg  = selReg.value ? parseInt(selReg.value) : null;
  state.prov = null;
  state.group = null;
  state.page = 0;
  state.selectedProCom = null;
  state.selectedProtectedId = null;
  clearSelection();

  selProv.innerHTML = '<option value="">— Tutte le Province —</option>';
  selProv.disabled = !state.reg;

  provincesLayer  = clearLayer(provincesLayer);
  municipalsLayer = clearLayer(municipalsLayer);
  protectedAreasLayer = clearLayer(protectedAreasLayer);
  highlightLayer  = clearLayer(highlightLayer);
  provincesGeoCache = null;

  renderRegionsLayer();

  if (state.reg) {
    const provs = await apiFetch(`/api/provinces?reg=${state.reg}`);
    provs.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.cod_prov;
      opt.textContent = `${p.sigla} — ${p.den_prov}`;
      selProv.appendChild(opt);
    });

    provincesGeoCache = await apiFetch(`/api/provinces/geojson?reg=${state.reg}`);
    renderProvincesLayer();
    if (regionsLayer && regionsLayer.getBounds().isValid()) {
      map.fitBounds(regionsLayer.getBounds(), { padding: [36, 36] });
    }
  } else {
    map.setView([42.5, 12.5], 6);
  }

  await refreshAdministrativeAreas();
  await loadMainList();
});

selProv.addEventListener('change', async () => {
  if (state.searchMode === 'parchi') return;
  state.prov = selProv.value ? parseInt(selProv.value) : null;
  state.group = null;
  state.page = 0;
  state.selectedProCom = null;
  state.selectedProtectedId = null;
  clearSelection();

  renderProvincesLayer();
  await refreshAdministrativeAreas();
  await loadMainList();
});

let searchTimer = null;
if (chkMontanoL131) {
  chkMontanoL131.addEventListener('change', async () => {
    state.page = 0;
    await loadMainList();
  });
}

if (chkHasContacts) {
  chkHasContacts.addEventListener('change', async () => {
    state.page = 0;
    await loadMainList();
  });
}

if (chkWithRei) {
  chkWithRei.addEventListener('change', async () => {
    state.page = 0;
    await loadMainList();
  });
}

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    state.q    = searchInput.value.trim();
    state.page = 0;
    await loadMainList();
  }, 300);
});

selGroupKind.addEventListener('change', async () => {
  selGroup.value = '';
  groupingLayer = clearLayer(groupingLayer);
  resetGroupDetailEmpty();
  try {
    await loadGroupsList();
  } catch (e) {
    console.warn(e);
  }
});

selGroup.addEventListener('change', () => {
  applySelectedGroup();
});

btnReset.addEventListener('click', async () => {
  selReg.value  = '';
  selProv.innerHTML = '<option value="">— Tutte le Province —</option>';
  selProv.disabled  = true;
  searchInput.value = '';
  if (chkMontanoL131) chkMontanoL131.checked = false;
  if (chkHasContacts) chkHasContacts.checked = false;
  if (chkWithRei) chkWithRei.checked = false;
  selGroupKind.value = '';
  selGroup.value = '';
  resetGroupDetailEmpty();
  state.reg  = null;
  state.prov = null;
  state.group = null;
  state.q    = '';
  state.page = 0;
  state.selectedProCom = null;
  state.selectedProtectedId = null;
  clearSelection();

  groupingLayer   = clearLayer(groupingLayer);
  provincesLayer  = clearLayer(provincesLayer);
  municipalsLayer = clearLayer(municipalsLayer);
  protectedAreasLayer = clearLayer(protectedAreasLayer);
  highlightLayer  = clearLayer(highlightLayer);
  provincesGeoCache = null;

  try {
    await loadGroupsList();
  } catch (e) {
    console.warn(e);
  }

  state.parkTypeChecked = {};
  renderRegionsLayer();
  map.setView([42.5, 12.5], 6);
  await refreshAdministrativeAreas();
  await loadMainList();
});

if (parkTypeList) {
  parkTypeList.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || t.type !== 'checkbox') return;
    const lab = t.closest('label.park-type-row');
    if (!lab || !lab.dataset) return;
    const key = parseParkTypeDataAttr(lab.dataset.parkType);
    state.parkTypeChecked[key] = t.checked;
    rebuildProtectedAreasLayer();
    clearParkHighlightIfHidden();
  });
}

if (btnParkTypesAll) {
  btnParkTypesAll.addEventListener('click', () => {
    state.parkTypeChecked = {};
    if (protectedAreasGeoCache) {
      syncParkTypePanelFromGeojson(protectedAreasGeoCache);
      rebuildProtectedAreasLayer();
      clearParkHighlightIfHidden();
    }
  });
}

// ── Map click handlers ───────────────────────────────────────────────────────
function onRegionClick(props) {
  const val = String(props.cod_reg);
  if (selReg.value !== val) {
    selReg.value = val;
    selReg.dispatchEvent(new Event('change'));
  } else if (regionsLayer && regionsLayer.getBounds().isValid()) {
    map.fitBounds(regionsLayer.getBounds(), { padding: [36, 36] });
  }
}

function onProvinceClick(props) {
  const val = String(props.cod_prov);
  if (selProv.value !== val) {
    selProv.value = val;
    selProv.dispatchEvent(new Event('change'));
  } else if (provincesLayer && provincesLayer.getBounds().isValid()) {
    map.fitBounds(provincesLayer.getBounds(), { padding: [28, 28] });
  }
}

async function onMunicipalityMapClick(props) {
  await selectMunicipality(props.pro_com);
}

// ── Load municipalities list ─────────────────────────────────────────────────
async function loadMunicipalities() {
  const params = new URLSearchParams({ limit: PAGE_SIZE, offset: state.page * PAGE_SIZE });
  if (state.reg)  params.set('reg', state.reg);
  if (state.prov) params.set('prov', state.prov);
  if (state.group) params.set('group', state.group);
  if (state.q)    params.set('q', state.q);
  if (chkMontanoL131 && chkMontanoL131.checked) params.set('montano_l131', '1');
  if (chkHasContacts && chkHasContacts.checked) params.set('has_contacts', '1');
  if (chkWithRei && chkWithRei.checked) params.set('with_rei', '1');

  const data = await apiFetch(`/api/municipalities?${params}`);
  state.total = data.total;

  renderTable(data.items);
  renderPagination();

  resultCount.textContent = `${data.total.toLocaleString('it-IT')} comuni`;
  resultHint.textContent  = state.group
    ? ''
    : state.prov
    ? ''
    : state.reg
      ? 'Seleziona una provincia per i confini comunali'
      : 'Seleziona una regione per iniziare';
}

// ── Table render ─────────────────────────────────────────────────────────────
function renderTable(items) {
  emptyState.classList.toggle('hidden', items.length > 0);
  tbody.innerHTML = '';

  items.forEach(m => {
    const hasInfo = !!(m.sito_web || m.email || m.pec || m.telefono || m.codice_fiscale || m.indirizzo_fisico);
    const tr = document.createElement('tr');
    tr.dataset.proCom = String(m.pro_com);
    if (m.pro_com === state.selectedProCom) tr.classList.add('selected');

    const kmSentieri = parseFloat(m.km_sentieri_total);
    const kmSentieriTxt = Number.isFinite(kmSentieri) && kmSentieri > 0
      ? kmSentieri.toFixed(1)
      : '—';

    tr.innerHTML = `
      <td class="check"><input type="checkbox" data-procom="${m.pro_com}" ${selected.has(m.pro_com) ? 'checked' : ''}></td>
      <td class="comune" title="${esc(m.comune)}">${esc(m.comune)}</td>
      <td>${esc(m.sigla || '—')}</td>
      <td title="${esc(m.den_reg || '')}">${esc(m.den_reg || '—')}</td>
      <td class="num">${fmtPop(m.popolazione_residente)}</td>
      <td class="num" title="${esc(altitudineTooltipPlain(m))}">${fmtQuotaMedia(m)}</td>
      <td class="num col-l131" title="${m.comune_montano_l131 ? 'Comune montano (L. 131/2025)' : ''}">${m.comune_montano_l131 ? 'Sì' : '—'}</td>
      <td class="col-pec" title="${m.pec ? esc(m.pec) : ''}">${m.pec ? 'Sì' : '—'}</td>
      <td class="col-info" title="${hasInfo ? 'Contatti/Info disponibili (clicca il comune per dettagli)' : ''}">${hasInfo ? 'Sì' : '—'}</td>
      <td class="num">${kmSentieriTxt}</td>
      <td class="code">${m.pro_com_t || m.pro_com}</td>
    `;

    tr.addEventListener('click', (e) => {
      const t = e.target;
      if (t && t.tagName === 'INPUT') return;
      selectMunicipality(m.pro_com);
    });
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('input[type="checkbox"][data-procom]').forEach((el) => {
    el.addEventListener('click', (e) => e.stopPropagation());
    el.addEventListener('change', (e) => {
      const procom = parseInt(e.target.getAttribute('data-procom'), 10);
      toggleSelected(procom, e.target.checked);
    });
  });

  const pageIds = items.map((m) => m.pro_com);
  const allChecked = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const someChecked = pageIds.some((id) => selected.has(id));
  const ca = chkAllEl();
  if (ca) {
    ca.indeterminate = !allChecked && someChecked;
    ca.checked = allChecked;
  }
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  return 'https://' + s;
}

function renderContactsHtml(p) {
  const parts = [];
  const sitoUrl = p && p.sito_web ? normalizeUrl(p.sito_web) : '';
  if (sitoUrl) parts.push(`Sito: <a href="${esc(sitoUrl)}" target="_blank" rel="noopener">${esc(p.sito_web)}</a>`);
  if (p.email) parts.push(`Email: <a href="mailto:${esc(p.email)}">${esc(p.email)}</a>`);
  if (p.pec) parts.push(`PEC: <a href="mailto:${esc(p.pec)}">${esc(p.pec)}</a>`);
  if (p.telefono) parts.push(`Tel: <a href="tel:${esc(p.telefono)}">${esc(p.telefono)}</a>`);
  if (p.codice_fiscale) parts.push(`CF: <code>${esc(p.codice_fiscale)}</code>`);
  if (p.indirizzo_fisico) parts.push(`Indirizzo: ${esc(p.indirizzo_fisico)}`);
  if (!parts.length) return '';
  return `<div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(148,163,184,.35);font-size:12px;line-height:1.35;">${parts.join('<br>')}</div>`;
}

function updateSelectedUI() {
  const n = selected.size;
  selCountEl.textContent = `${n} selezionati`;
  btnExportPng.disabled = n === 0;
  btnExportPdf.disabled = n === 0;
}

function toggleSelected(procom, checked) {
  if (checked) selected.add(procom);
  else selected.delete(procom);
  updateSelectedUI();
}

function clearSelection() {
  selected.clear();
  updateSelectedUI();
  const ca = chkAllEl();
  if (ca) {
    ca.indeterminate = false;
    ca.checked = false;
  }
}

// ── Pagination ───────────────────────────────────────────────────────────────
function renderPagination() {
  const total = Math.ceil(state.total / PAGE_SIZE);
  paginationEl.innerHTML = '';
  if (total <= 1) return;

  const prev = btn('‹', state.page > 0, () => { state.page--; loadMainList(); });
  const info = document.createElement('span');
  info.id = 'page-info';
  info.textContent = `${state.page + 1} / ${total}`;
  const next = btn('›', state.page < total - 1, () => { state.page++; loadMainList(); });

  paginationEl.append(prev, info, next);
}

function btn(label, enabled, onClick) {
  const b = document.createElement('button');
  b.className = 'btn-page';
  b.textContent = label;
  b.disabled = !enabled;
  if (enabled) b.addEventListener('click', onClick);
  return b;
}

document.getElementById('table-area').addEventListener('change', (e) => {
  const t = e.target;
  if (!t || t.id !== 'chk-all') return;
  const ca = chkAllEl();
  if (!ca) return;
  const checks = tbody.querySelectorAll('input[type="checkbox"][data-procom]');
  checks.forEach((c) => {
    const procom = parseInt(c.getAttribute('data-procom'), 10);
    c.checked = ca.checked;
    toggleSelected(procom, ca.checked);
  });
});

// ── Select/highlight municipality ────────────────────────────────────────────
async function selectMunicipality(procom) {
  state.selectedProCom = procom;
  state.selectedProtectedId = null;

  // Update table highlight
  document.querySelectorAll('#tbody tr').forEach(tr => tr.classList.remove('selected'));
  const rows = Array.from(document.querySelectorAll('#tbody tr'));
  const found = rows.find((tr) => tr.dataset.proCom === String(procom));
  if (found) { found.classList.add('selected'); found.scrollIntoView({ block: 'nearest' }); }

  // Fetch geometry and show on map
  highlightLayer = clearLayer(highlightLayer);
  try {
    const feat = await apiFetch(`/api/municipalities/${procom}`);
    highlightLayer = L.geoJSON(feat, { style: () => style.selected }).addTo(map);
    map.fitBounds(highlightLayer.getBounds(), { maxZoom: 13, padding: [40, 40] });

    const p = feat.properties;
    const contatti = renderContactsHtml(p);
    const popup = L.popup()
      .setLatLng(highlightLayer.getBounds().getCenter())
      .setContent(`
        <strong>${p.comune}</strong>
        ${p.comune_a ? `<br><em>${p.comune_a}</em>` : ''}
        <div class="meta">
          ${p.den_prov} (${p.sigla}) &bull; ${p.den_reg}<br>
          Cod. ISTAT: <code>${p.pro_com_t || p.pro_com}</code>
          ${p.cc_uts ? ` &bull; Cat: ${p.cc_uts}` : ''}
          ${p.popolazione_residente != null ? `<br>Abitanti (ISTAT, 1º gen. ${p.popolazione_istat_anno ?? '—'}): ${fmtPop(p.popolazione_residente)}` : ''}
          ${(p.altitudine_media_sl_m != null || p.altitudine_min_sl_m != null || p.altitudine_max_sl_m != null)
        ? `<br>Altitudine (ISTAT DEM,${p.altitudine_istat_anno ? ' ref. ' + esc(String(p.altitudine_istat_anno)) : ''}):<br>
              media ~${fmtQuotaMedia(p)} m · estremi ${fmtAltEstremiPair(p)}
              ${p.altitudine_centro_municipio_sl_m != null ? ` · centroide ${fmtPop(p.altitudine_centro_municipio_sl_m)} m` : ''}`
        : ''}
          ${p.area_km2 ? `<br>Superficie: ${parseFloat(p.area_km2).toFixed(1)} km²` : ''}
          ${p.comune_montano_l131 ? '<br><strong>Montano</strong> (L. 131/2025)' : ''}
          ${(parseFloat(p.km_sentieri_total) > 0) ? `<br>Sentieri CAI: ${parseFloat(p.km_sentieri_total).toFixed(1)} km <span style="color:#64748b;font-size:11px">(SDA3: ${parseFloat(p.km_sentieri_sda3 || 0).toFixed(1)} · SDA4: ${parseFloat(p.km_sentieri_sda4 || 0).toFixed(1)})</span>` : ''}
          ${contatti ? `<br>${contatti}` : ''}
        </div>
      `)
      .openOn(map);
  } catch (e) {
    console.error('Failed to load municipality geometry', e);
  }
}

async function buildExportCardData() {
  const ids = [...selected.values()];
  const qs = `?ids=${encodeURIComponent(ids.join(','))}`;
  const [stats, geo] = await Promise.all([
    apiFetch(`/api/municipalities/stats${qs}`),
    apiFetch(`/api/municipalities/geojson/by-ids${qs}`),
  ]);
  return { ids, stats, geo };
}

function fmtKm2(n) {
  const v = typeof n === 'number' ? n : parseFloat(String(n || '0'));
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('it-IT', { maximumFractionDigits: 1 });
}

function fmtPop(n) {
  if (n == null || n === '') return '—';
  const v = typeof n === 'number' ? n : parseInt(String(n), 10);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('it-IT');
}

/** Media altitudine territoriale (m s.l.m., ISTAT). */
function fmtQuotaMedia(m) {
  if (!m || m.altitudine_media_sl_m == null || m.altitudine_media_sl_m === '') return '—';
  const v = typeof m.altitudine_media_sl_m === 'number'
    ? m.altitudine_media_sl_m
    : parseFloat(String(m.altitudine_media_sl_m).replace(',', '.'));
  if (!Number.isFinite(v)) return '—';
  return Math.round(v).toLocaleString('it-IT');
}

function fmtAltEstremiPair(p) {
  const a = p.altitudine_min_sl_m;
  const b = p.altitudine_max_sl_m;
  if ((a == null || a === '') && (b == null || b === '')) return '—';
  return `${a != null && a !== '' ? fmtPop(a) : '—'}–${b != null && b !== '' ? fmtPop(b) : '—'} m`;
}

/** Testo tooltip elenco comuni */
function altitudineTooltipPlain(m) {
  if (!m || (m.altitudine_media_sl_m == null && m.altitudine_min_sl_m == null && m.altitudine_max_sl_m == null)) return '';
  const parts = [];
  if (m.altitudine_min_sl_m != null || m.altitudine_max_sl_m != null) {
    parts.push(`Min–max: ${m.altitudine_min_sl_m ?? '—'}–${m.altitudine_max_sl_m ?? '—'} m`);
  }
  if (m.altitudine_centro_municipio_sl_m != null) {
    parts.push(`Centroide: ${String(m.altitudine_centro_municipio_sl_m)} m`);
  }
  parts.push(`Media territorio: ${fmtQuotaMedia(m)} m`);
  if (m.altitudine_istat_anno) parts.push(`Rif. dataset ISTAT (${m.altitudine_istat_anno})`);
  return parts.join(' · ');
}

async function renderCardAndCapture(kind /* 'png' | 'pdf' */) {
  const { stats, geo } = await buildExportCardData();

  const card = document.createElement('div');
  card.style.position = 'fixed';
  card.style.left = '-99999px';
  card.style.top = '0';
  card.style.width = '1000px';
  card.style.background = '#0f172a';
  card.style.color = '#f1f5f9';
  card.style.fontFamily = 'Inter, system-ui, -apple-system, sans-serif';
  card.style.padding = '18px';
  card.style.border = '1px solid #334155';
  card.style.borderRadius = '12px';

  const title = document.createElement('div');
  title.style.display = 'flex';
  title.style.justifyContent = 'space-between';
  title.style.alignItems = 'baseline';
  title.innerHTML = `<div style="font-size:16px;font-weight:700;">Scheda comuni</div>
    <div style="font-size:12px;color:#94a3b8;">${new Date().toLocaleDateString('it-IT')}</div>`;

  const summary = document.createElement('div');
  summary.style.marginTop = '8px';
  summary.style.fontSize = '12px';
  summary.style.color = '#cbd5e1';
  const popSum = stats.items.reduce((acc, m) => {
    const v = parseInt(String(m.popolazione_residente), 10);
    return acc + (Number.isFinite(v) ? v : 0);
  }, 0);
  const anyPop = stats.items.some((m) => m.popolazione_residente != null);
  summary.innerHTML = `<strong>${stats.count}</strong> comuni · <strong>${fmtKm2(stats.total_area_km2)}</strong> km² totali` +
    (anyPop ? ` · <strong>${popSum.toLocaleString('it-IT')}</strong> abitanti (ISTAT)` : '');

  const mapWrap = document.createElement('div');
  mapWrap.style.marginTop = '12px';
  mapWrap.style.height = '480px';
  mapWrap.style.border = '1px solid #334155';
  mapWrap.style.borderRadius = '10px';
  mapWrap.style.overflow = 'hidden';

  const mapDiv = document.createElement('div');
  mapDiv.style.height = '100%';
  mapWrap.appendChild(mapDiv);

  const list = document.createElement('div');
  list.style.marginTop = '12px';
  list.style.borderTop = '1px solid #334155';
  list.style.paddingTop = '10px';
  list.style.fontSize = '12px';
  list.style.color = '#e2e8f0';

  const rows = stats.items.map((m) => {
    const prov = m.sigla || '—';
    return `<tr>
      <td style="padding:6px 8px;border-bottom:1px solid #334155;">${esc(m.comune)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #334155;color:#94a3b8;">${esc(prov)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #334155;text-align:right;font-variant-numeric:tabular-nums;">${fmtPop(m.popolazione_residente)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #334155;text-align:right;font-variant-numeric:tabular-nums;" title="${esc(altitudineTooltipPlain(m))}">${fmtQuotaMedia(m)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #334155;text-align:center;color:#94a3b8;">${m.comune_montano_l131 ? 'Sì' : '—'}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #334155;text-align:right;">${fmtKm2(m.area_km2)} km²</td>
    </tr>`;
  }).join('');

  list.innerHTML = `
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr>
          <th style="text-align:left;padding:6px 8px;color:#94a3b8;border-bottom:1px solid #334155;">Comune</th>
          <th style="text-align:left;padding:6px 8px;color:#94a3b8;border-bottom:1px solid #334155;">Prov</th>
          <th style="text-align:right;padding:6px 8px;color:#94a3b8;border-bottom:1px solid #334155;">Abitanti</th>
          <th style="text-align:right;padding:6px 8px;color:#94a3b8;border-bottom:1px solid #334155;">Quota m</th>
          <th style="text-align:center;padding:6px 8px;color:#94a3b8;border-bottom:1px solid #334155;">L.131</th>
          <th style="text-align:right;padding:6px 8px;color:#94a3b8;border-bottom:1px solid #334155;">Superficie</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <td colspan="2" style="padding:8px;color:#94a3b8;text-align:right;">Totale</td>
          <td style="padding:8px;text-align:right;font-weight:700;font-variant-numeric:tabular-nums;">${anyPop ? popSum.toLocaleString('it-IT') : '—'}</td>
          <td style="padding:8px;text-align:right;font-weight:700;color:#64748b;">—</td>
          <td style="padding:8px;text-align:center;font-weight:700;color:#64748b;">—</td>
          <td style="padding:8px;text-align:right;font-weight:700;">${fmtKm2(stats.total_area_km2)} km²</td>
        </tr>
      </tfoot>
    </table>
  `;

  card.appendChild(title);
  card.appendChild(summary);
  card.appendChild(mapWrap);
  card.appendChild(list);
  document.body.appendChild(card);

  const expMap = L.map(mapDiv, { zoomControl: false, attributionControl: false, preferCanvas: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    crossOrigin: true,
  }).addTo(expMap);

  const layer = L.geoJSON(geo, { style: () => style.municipalityGroup }).addTo(expMap);
  expMap.fitBounds(layer.getBounds(), { padding: [20, 20] });

  await new Promise((r) => setTimeout(r, 1200));

  // globals loaded via CDN
  // eslint-disable-next-line no-undef
  const canvas = await html2canvas(card, { useCORS: true, backgroundColor: '#0f172a', scale: 2 });
  const dataUrl = canvas.toDataURL('image/png');

  expMap.remove();
  card.remove();

  if (kind === 'png') {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `scheda-comuni-${Date.now()}.png`;
    a.click();
    return;
  }

  // eslint-disable-next-line no-undef
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const img = new Image();
  img.src = dataUrl;
  await new Promise((r) => { img.onload = r; });
  const ratio = Math.min(pageW / img.width, pageH / img.height);
  const w = img.width * ratio;
  const h = img.height * ratio;
  pdf.addImage(dataUrl, 'PNG', (pageW - w) / 2, (pageH - h) / 2, w, h);
  pdf.save(`scheda-comuni-${Date.now()}.pdf`);
}

btnExportPng.addEventListener('click', async () => {
  try {
    await renderCardAndCapture('png');
    clearSelection();
    await loadMainList();
  } catch (e) {
    console.error(e);
  }
});
btnExportPdf.addEventListener('click', async () => {
  try {
    await renderCardAndCapture('pdf');
    clearSelection();
    await loadMainList();
  } catch (e) {
    console.error(e);
  }
});

// ── Sidebar resize (persistenza larghezza) ───────────────────────────────────
const SIDEBAR_WIDTH_LS = 'webmapp_comuni_sidebar_w_px';
/** Layout a colonna singola */
const mqSidebarStack = window.matchMedia('(max-width: 900px)');

function sidebarWidthMaxPx() {
  return Math.floor(window.innerWidth * 0.72);
}

function clampSidebarPx(px) {
  const min = 280;
  const max = Math.max(min + 120, sidebarWidthMaxPx());
  return Math.round(Math.min(Math.max(px, min), max));
}

function clearSidebarInlineWidth(sidebarEl) {
  sidebarEl.style.width = '';
  sidebarEl.style.flexBasis = '';
  sidebarEl.style.maxWidth = '';
}

function sidebarPersistWidth(sidebarEl) {
  if (mqSidebarStack.matches) return;
  localStorage.setItem(SIDEBAR_WIDTH_LS, String(Math.round(sidebarEl.getBoundingClientRect().width)));
}

function sidebarApplyPx(sidebarEl, px, { persist } = {}) {
  if (mqSidebarStack.matches) return;
  const w = clampSidebarPx(px);
  sidebarEl.style.flexBasis = `${w}px`;
  sidebarEl.style.width = `${w}px`;
  sidebarEl.style.maxWidth = 'none';
  map.invalidateSize();
  if (persist) sidebarPersistWidth(sidebarEl);
}

function sidebarRestoreStoredOrCss(sidebarEl) {
  if (mqSidebarStack.matches) {
    clearSidebarInlineWidth(sidebarEl);
    return;
  }
  const raw = localStorage.getItem(SIDEBAR_WIDTH_LS);
  if (raw == null || raw === '') {
    clearSidebarInlineWidth(sidebarEl);
    return;
  }
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    clearSidebarInlineWidth(sidebarEl);
    return;
  }
  sidebarApplyPx(sidebarEl, parsed);
}

/** Trascina il bordo fra pannello e mappa; doppio clic ripristina; frecce con focus su separatore */
function setupSidebarResize() {
  const sidebarEl = document.getElementById('sidebar');
  const grip = document.getElementById('sidebar-resizer');
  if (!sidebarEl || !grip) return;

  let mapResizeRaf = 0;
  function scheduleMapResize() {
    if (mapResizeRaf) cancelAnimationFrame(mapResizeRaf);
    mapResizeRaf = requestAnimationFrame(() => {
      map.invalidateSize();
      mapResizeRaf = 0;
    });
  }

  function syncLayoutMode() {
    if (mqSidebarStack.matches) {
      clearSidebarInlineWidth(sidebarEl);
    } else {
      sidebarRestoreStoredOrCss(sidebarEl);
    }
    map.invalidateSize();
  }

  mqSidebarStack.addEventListener('change', syncLayoutMode);
  sidebarRestoreStoredOrCss(sidebarEl);

  let drag = null;

  grip.addEventListener('dblclick', (e) => {
    if (mqSidebarStack.matches) return;
    e.preventDefault();
    localStorage.removeItem(SIDEBAR_WIDTH_LS);
    clearSidebarInlineWidth(sidebarEl);
    map.invalidateSize();
  });

  grip.addEventListener('pointerdown', (e) => {
    if (mqSidebarStack.matches || e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarEl.getBoundingClientRect().width;
    drag = { pid: e.pointerId, startX, startW };
    grip.classList.add('is-dragging');
    try {
      grip.setPointerCapture(e.pointerId);
    } catch (_) { /* ignore */ }
  });

  grip.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pid) return;
    sidebarApplyPx(sidebarEl, drag.startW + (e.clientX - drag.startX));
    scheduleMapResize();
  });

  function endDrag(e) {
    if (!drag) return;
    if (e && e.pointerId != null && e.pointerId !== drag.pid) return;
    grip.classList.remove('is-dragging');
    try {
      grip.releasePointerCapture(drag.pid);
    } catch (_) { /* ignore */ }
    sidebarPersistWidth(sidebarEl);
    drag = null;
    map.invalidateSize();
  }

  grip.addEventListener('pointerup', endDrag);
  grip.addEventListener('pointercancel', endDrag);
  grip.addEventListener('lostpointercapture', (ev) => {
    if (!drag || ev.pointerId !== drag.pid) return;
    grip.classList.remove('is-dragging');
    sidebarPersistWidth(sidebarEl);
    drag = null;
    map.invalidateSize();
  });

  grip.addEventListener('keydown', (e) => {
    if (mqSidebarStack.matches) return;
    const step = e.shiftKey ? 32 : 12;
    const cur = sidebarEl.getBoundingClientRect().width;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      sidebarApplyPx(sidebarEl, cur - step, { persist: true });
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      sidebarApplyPx(sidebarEl, cur + step, { persist: true });
    } else if (e.key === 'Home') {
      e.preventDefault();
      sidebarApplyPx(sidebarEl, 280, { persist: true });
    } else if (e.key === 'End') {
      e.preventDefault();
      sidebarApplyPx(sidebarEl, sidebarWidthMaxPx(), { persist: true });
    }
  });
}

setupSidebarResize();

// ── Start ────────────────────────────────────────────────────────────────────
init().catch(err => {
  console.error(err);
  loadingMsg.textContent = 'Errore di connessione. Verificare che i servizi siano avviati.';
});
