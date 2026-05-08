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
};

// ── DOM refs ─────────────────────────────────────────────────────────────────
const selReg       = document.getElementById('sel-reg');
const selProv      = document.getElementById('sel-prov');
const searchInput  = document.getElementById('search-input');
const btnReset     = document.getElementById('btn-reset');
const chkMontanoL131 = document.getElementById('chk-montano-l131');
const chkHasContacts = document.getElementById('chk-has-contacts');
const chkAll       = document.getElementById('chk-all');
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

const selected = new Set(); // pro_com selezionati (export)

// ── Map ──────────────────────────────────────────────────────────────────────
const map = L.map('map', { zoomControl: true }).setView([42.5, 12.5], 6);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 18,
  crossOrigin: true,
}).addTo(map);

const style = {
  region:       { color: '#3b82f6', weight: 1.5, fillColor: '#3b82f6', fillOpacity: 0.06 },
  province:     { color: '#8b5cf6', weight: 1.5, fillColor: '#8b5cf6', fillOpacity: 0.08 },
  municipality: { color: '#06b6d4', weight: 1,   fillColor: '#06b6d4', fillOpacity: 0.10 },
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

function clearLayer(ref) { if (ref) map.removeLayer(ref); return null; }

function featCodReg(f) {
  const cr = f.properties.cod_reg;
  return typeof cr === 'number' ? cr : parseInt(String(cr), 10);
}

function featCodProv(f) {
  const cp = f.properties.cod_prov;
  return typeof cp === 'number' ? cp : parseInt(String(cp), 10);
}

/** Mostra tutte le regioni oppure solo quella selezionata in `state.reg`. */
function renderRegionsLayer() {
  regionsLayer = clearLayer(regionsLayer);
  if (!regionsGeoCache) return;
  const all = regionsGeoCache.features || [];
  const features = state.reg == null
    ? all
    : all.filter((f) => featCodReg(f) === state.reg);
  const collection = { type: 'FeatureCollection', features };
  regionsLayer = makeGeoLayer(collection, style.region, onRegionClick).addTo(map);
}

/** Province della regione corrente: tutte se `state.prov` è null, altrimenti solo quella selezionata. */
function renderProvincesLayer() {
  provincesLayer = clearLayer(provincesLayer);
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

  const total = await apiFetch('/api/municipalities?limit=1&offset=0');
  statsEl.textContent = `${total.total.toLocaleString('it-IT')} comuni totali`;

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
  await loadMunicipalities();
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
  groupingLayer = clearLayer(groupingLayer);
  municipalsLayer = clearLayer(municipalsLayer);
  highlightLayer = clearLayer(highlightLayer);
  const gid = selGroup.value;
  if (!gid) {
    state.group = null;
    resetGroupDetailEmpty();
    state.page = 0;
    clearSelection();
    await loadMunicipalities();
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
    await loadMunicipalities();
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
selReg.addEventListener('change', async () => {
  state.reg  = selReg.value ? parseInt(selReg.value) : null;
  state.prov = null;
  state.group = null;
  state.page = 0;
  state.selectedProCom = null;
  clearSelection();

  selProv.innerHTML = '<option value="">— Tutte le Province —</option>';
  selProv.disabled = !state.reg;

  provincesLayer  = clearLayer(provincesLayer);
  municipalsLayer = clearLayer(municipalsLayer);
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

  await loadMunicipalities();
});

selProv.addEventListener('change', async () => {
  state.prov = selProv.value ? parseInt(selProv.value) : null;
  state.group = null;
  state.page = 0;
  state.selectedProCom = null;
  clearSelection();

  municipalsLayer = clearLayer(municipalsLayer);
  highlightLayer  = clearLayer(highlightLayer);

  renderProvincesLayer();

  if (state.prov) {
    const geoM = await apiFetch(`/api/municipalities/geojson?prov=${state.prov}`);
    municipalsLayer = makeGeoLayer(geoM, style.municipality, onMunicipalityMapClick).addTo(map);
    if (provincesLayer && provincesLayer.getBounds().isValid()) {
      map.fitBounds(provincesLayer.getBounds(), { padding: [28, 28] });
    }
  } else if (state.reg && provincesLayer && provincesLayer.getBounds().isValid()) {
    map.fitBounds(provincesLayer.getBounds(), { padding: [30, 30] });
  }

  await loadMunicipalities();
});

let searchTimer = null;
if (chkMontanoL131) {
  chkMontanoL131.addEventListener('change', async () => {
    state.page = 0;
    await loadMunicipalities();
  });
}

if (chkHasContacts) {
  chkHasContacts.addEventListener('change', async () => {
    state.page = 0;
    await loadMunicipalities();
  });
}

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    state.q    = searchInput.value.trim();
    state.page = 0;
    await loadMunicipalities();
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
  selGroupKind.value = '';
  selGroup.value = '';
  resetGroupDetailEmpty();
  state.reg  = null;
  state.prov = null;
  state.group = null;
  state.q    = '';
  state.page = 0;
  state.selectedProCom = null;
  clearSelection();

  groupingLayer   = clearLayer(groupingLayer);
  provincesLayer  = clearLayer(provincesLayer);
  municipalsLayer = clearLayer(municipalsLayer);
  highlightLayer  = clearLayer(highlightLayer);
  provincesGeoCache = null;

  try {
    await loadGroupsList();
  } catch (e) {
    console.warn(e);
  }

  renderRegionsLayer();
  map.setView([42.5, 12.5], 6);
  loadMunicipalities();
});

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
  chkAll.indeterminate = !allChecked && someChecked;
  chkAll.checked = allChecked;
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
  chkAll.indeterminate = false;
  chkAll.checked = false;
}

// ── Pagination ───────────────────────────────────────────────────────────────
function renderPagination() {
  const total = Math.ceil(state.total / PAGE_SIZE);
  paginationEl.innerHTML = '';
  if (total <= 1) return;

  const prev = btn('‹', state.page > 0, () => { state.page--; loadMunicipalities(); });
  const info = document.createElement('span');
  info.id = 'page-info';
  info.textContent = `${state.page + 1} / ${total}`;
  const next = btn('›', state.page < total - 1, () => { state.page++; loadMunicipalities(); });

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

chkAll.addEventListener('change', () => {
  const checks = tbody.querySelectorAll('input[type="checkbox"][data-procom]');
  checks.forEach((c) => {
    const procom = parseInt(c.getAttribute('data-procom'), 10);
    c.checked = chkAll.checked;
    toggleSelected(procom, chkAll.checked);
  });
});

// ── Select/highlight municipality ────────────────────────────────────────────
async function selectMunicipality(procom) {
  state.selectedProCom = procom;

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
    await loadMunicipalities();
  } catch (e) {
    console.error(e);
  }
});
btnExportPdf.addEventListener('click', async () => {
  try {
    await renderCardAndCapture('pdf');
    clearSelection();
    await loadMunicipalities();
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
