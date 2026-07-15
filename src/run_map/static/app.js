// ---- Map setup -----------------------------------------------------------

const map = L.map('map', {
  preferCanvas: true,           // canvas renderer = sharper many-track rendering
}).setView([54, -2], 6);
// Dedicated panes so matched tracks always render above the aggregate layer,
// regardless of layer-add order (aggregate LOD swaps re-add the layer, which
// would otherwise stack on top of earlier-added matches).
map.createPane('aggPane');
map.getPane('aggPane').style.zIndex = 410;
map.createPane('matchPane');
map.getPane('matchPane').style.zIndex = 450;
// Each pane needs its own canvas renderer; sharing one canvas across panes
// breaks the layering since canvas draw order trumps z-index.
const aggRenderer = L.canvas({ pane: 'aggPane' });
const matchRenderer = L.canvas({ pane: 'matchPane' });
// Inspection API for the Playwright smoke tests. Read-only — tests assert on
// layer presence and match counts without poking module-local variables.
window.__rm = {
  map,
  matchCount: () => matchLayersById.size,
  heatmapOn: () => !!heatmapLayer && map.hasLayer(heatmapLayer),
  hexOn: () => !!hexLayer && map.hasLayer(hexLayer),
  aggregateOn: () => !!activeAggLod && !!aggregateLayers[activeAggLod] && map.hasLayer(aggregateLayers[activeAggLod]),
  aggregateLod: () => activeAggLod,
  snapSegmentsLoaded: () => aggregateSegments.length,
  distSnapValues: () => _distSnapValues.slice(),
  get indexById() { return indexById; },
  gearFilter: () => (activeFilters.gear ? activeFilters.gear.slice() : null),
};

const _osmAttr = '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>';
const _tfAttr = `Maps &copy; <a href="https://www.thunderforest.com">Thunderforest</a>, data ${_osmAttr}`;
const TF_KEY_STORAGE = 'runmap.tfApiKey';
function _tfKey() { return localStorage.getItem(TF_KEY_STORAGE) || ''; }
// Display name → Thunderforest style slug. Each requires a personal apikey
// (see https://manage.thunderforest.com/users/sign_up?price=hobby-project-usd).
const TF_STYLES = {
  'Thunderforest Outdoors': 'outdoors',
  'Thunderforest Landscape': 'landscape',
  'Thunderforest OpenCycleMap': 'cycle',
};
function _buildTFLayer(style) {
  return L.tileLayer(
    'https://{s}.tile.thunderforest.com/' + style + '/{z}/{x}/{y}.png?apikey={apikey}',
    { attribution: _tfAttr, maxZoom: 22, apikey: _tfKey() }
  );
}
const baseLayers = {
  'Topo (OpenTopoMap)': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    attribution: `${_osmAttr}, &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)`,
    maxZoom: 17,
  }),
  'OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: _osmAttr,
    maxZoom: 19,
  }),
  'Light (Carto)': L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: `${_osmAttr} &copy; <a href="https://carto.com/attributions">CARTO</a>`,
    maxZoom: 19,
  }),
  'Cycle (CyclOSM)': L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', {
    attribution: `${_osmAttr}, &copy; <a href="https://www.cyclosm.org">CyclOSM</a>`,
    maxZoom: 19,
  }),
  'Satellite': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri',
    maxZoom: 19,
  }),
};
for (const [name, style] of Object.entries(TF_STYLES)) {
  baseLayers[name] = _buildTFLayer(style);
}
function _isTFName(name) { return Object.prototype.hasOwnProperty.call(TF_STYLES, name); }
function _activeBaseLayerName() {
  for (const [name, layer] of Object.entries(baseLayers)) {
    if (layer === activeBaseLayer) return name;
  }
  return null;
}
// Rebuild TF layers when the apikey changes so the new key takes effect
// immediately, including for the currently-active layer.
function rebuildTFLayers() {
  const activeName = _activeBaseLayerName();
  for (const [name, style] of Object.entries(TF_STYLES)) {
    const old = baseLayers[name];
    const fresh = _buildTFLayer(style);
    baseLayers[name] = fresh;
    if (old === activeBaseLayer) {
      const op = parseFloat(document.getElementById('base-opacity').value) / 100;
      map.removeLayer(old);
      activeBaseLayer = fresh;
      fresh.setOpacity(op);
      fresh.addTo(map);
    }
  }
  // _activeBaseLayerName guard above ensures we re-point the active reference.
  if (activeName && _isTFName(activeName)) activeBaseLayer = baseLayers[activeName];
}
let activeBaseLayer = baseLayers['Topo (OpenTopoMap)'];
activeBaseLayer.setOpacity(0.5);
activeBaseLayer.addTo(map);

function setBaseLayer(name) {
  const next = baseLayers[name];
  if (!next || next === activeBaseLayer) return;
  if (_isTFName(name) && !_tfKey()) {
    showToast('Thunderforest needs an API key — add it in Settings.');
    const sel = document.getElementById('base-layer');
    const current = _activeBaseLayerName();
    if (sel && current) sel.value = current;
    return;
  }
  map.removeLayer(activeBaseLayer);
  activeBaseLayer = next;
  const opacity = parseFloat(document.getElementById('base-opacity').value) / 100;
  activeBaseLayer.setOpacity(opacity);
  activeBaseLayer.addTo(map);
}

function setBaseOpacity(pct) {
  activeBaseLayer.setOpacity(pct / 100);
}

const drawnItems = new L.FeatureGroup().addTo(map);
map.addControl(new L.Control.Draw({
  draw: { polyline: false, circle: false, marker: false, circlemarker: false },
  edit: { featureGroup: drawnItems, edit: false, remove: false },
}));

// Map-anchored popover controls.
// Each registers a small Leaflet button on the top-left toolbar that toggles
// a popover anchored next to it.
function makeMenuControl(label, title, menuId, fontSize = '18px') {
  return L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
      const a = L.DomUtil.create('a', '', div);
      a.href = '#'; a.title = title; a.textContent = label;
      a.style.fontSize = fontSize; a.style.lineHeight = '26px'; a.style.textAlign = 'center';
      L.DomEvent.on(a, 'click', e => {
        L.DomEvent.preventDefault(e);
        const menu = document.getElementById(menuId);
        const rect = a.getBoundingClientRect();
        menu.style.top = `${rect.bottom + 6}px`;
        menu.style.left = `${rect.left}px`;
        // Close any other open map-anchored menu.
        for (const id of ['display-menu']) {
          if (id !== menuId) document.getElementById(id).classList.add('hidden');
        }
        menu.classList.toggle('hidden');
      });
      return div;
    },
  });
}

// Single-action ⟲ button: fly to the most recent run.
const ResetControl = L.Control.extend({
  options: { position: 'topleft' },
  onAdd() {
    const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
    const a = L.DomUtil.create('a', '', div);
    a.href = '#'; a.title = 'Fly to most recent run'; a.textContent = '⟲';
    a.style.fontSize = '18px';
    a.style.lineHeight = '26px';
    a.style.textAlign = 'center';
    L.DomEvent.on(a, 'click', e => {
      L.DomEvent.preventDefault(e);
      resetToLastRun();
    });
    return div;
  },
});
map.addControl(new ResetControl());
const DisplayMenuCtl = makeMenuControl('🗺', 'Display', 'display-menu', '16px');
const displayCtl = new DisplayMenuCtl();
map.addControl(displayCtl);

// Hover-to-open for the 🗺 popover: open on pointer-enter over the button,
// stay open while the cursor is over either the button or the menu, close on
// exit from both. Falls back to click as a toggle on touch devices.
(function _wireDisplayHover() {
  const menu = document.getElementById('display-menu');
  const btnLink = displayCtl.getContainer().querySelector('a');
  if (!menu || !btnLink) return;
  let closeTimer = null;
  function open() {
    clearTimeout(closeTimer);
    const rect = btnLink.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 6}px`;
    menu.style.left = `${rect.left}px`;
    menu.classList.remove('hidden');
  }
  function scheduleClose() {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => menu.classList.add('hidden'), 180);
  }
  btnLink.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') open(); });
  btnLink.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') scheduleClose(); });
  menu.addEventListener('pointerenter', () => clearTimeout(closeTimer));
  menu.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') scheduleClose(); });
})();

// Funnel button — opens the filter pane (formerly anchored on the top-center
// "+ Filter" chip).
const FilterControl = L.Control.extend({
  options: { position: 'topleft' },
  onAdd() {
    const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
    const a = L.DomUtil.create('a', '', div);
    a.href = '#'; a.title = 'Filter'; a.id = 'filter-control-btn';
    a.style.lineHeight = '26px'; a.style.textAlign = 'center';
    a.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" style="vertical-align:middle"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" d="M3 5h18l-7 9v6l-4-2v-4z"/></svg>';
    L.DomEvent.on(a, 'click', e => {
      L.DomEvent.preventDefault(e);
      L.DomEvent.stopPropagation(e);
      toggleFilterMenu(a);
    });
    return div;
  },
});
const _filterCtl = new FilterControl();
map.addControl(_filterCtl);

// Hover-to-open for the filter funnel: mirrors the 🗺 display popover.
// While the pointer is over the button or the popover, the pane stays open;
// it closes after a short grace period when both are exited. Type pills are
// included as a "stay open" zone since they live right next to the menu.
(function _wireFilterHover() {
  const menu = document.getElementById('filter-menu');
  const btnLink = _filterCtl.getContainer().querySelector('a');
  if (!menu || !btnLink) return;
  let closeTimer = null;
  function open() {
    clearTimeout(closeTimer);
    if (menu.classList.contains('hidden')) toggleFilterMenu(btnLink);
  }
  function scheduleClose() {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      // Don't yank the pane shut if the user is mid-interaction with the
      // date picker — flatpickr's calendar lives in document.body.
      if (document.querySelector('.flatpickr-calendar.open')) return;
      if (!menu.classList.contains('hidden')) toggleFilterMenu(btnLink);
    }, 240);
  }
  btnLink.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') open(); });
  btnLink.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') scheduleClose(); });
  menu.addEventListener('pointerenter', () => clearTimeout(closeTimer));
  menu.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') scheduleClose(); });
})();

// Close map-anchored menus when clicking outside. Use the capture phase so
// we evaluate `e.target.closest('.flatpickr-calendar')` BEFORE flatpickr's
// own click handler detaches the clicked element during re-render.
document.addEventListener('click', e => {
  let closedAny = false;
  for (const id of ['display-menu', 'filter-menu']) {
    const menu = document.getElementById(id);
    if (menu.classList.contains('hidden')) continue;
    if (e.target.closest(`#${id}`)) continue;
    if (e.target.closest('.leaflet-control')) continue;
    // Flatpickr renders its calendar in document.body; while the picker is
    // open, any stray click (target inside the calendar, or quirky targets
    // like BODY when the picker swallows propagation) must not collapse the
    // host filter pane — there'd be no way to land on Apply.
    if (id === 'filter-menu' && (
          e.target.closest('.flatpickr-calendar') ||
          document.querySelector('.flatpickr-calendar.open') ||
          e.target.closest('#filter-bar') ||
          e.target.closest('#type-pills')
        )) continue;
    menu.classList.add('hidden');
    if (id === 'filter-menu') document.body.classList.remove('filter-menu-open');
    closedAny = true;
  }
  // A click that dismissed a popover has done its job — if it landed on the
  // map, don't let it fall through to Leaflet and fire a match query.
  if (closedAny && e.target.closest('#map')) {
    e.stopPropagation();
    e.preventDefault();
  }
}, true);

// Path styling.
// The aggregate layer is one big GeoJSON of every road/trail you've run —
// a "street map of your runs". Worn-path rendering: the server buckets
// segments by how many activities crossed them, and habitual routes draw
// heavier than one-offs (single hue; weight + opacity carry the frequency).
// Dark navy — deliberately darker than any of the basemaps' own blues
// (OpenTopoMap streams/rivers) so tracks never read as hydrology.
const AGG_COLOR = '#0d3457';
const STYLE_AGG = { color: AGG_COLOR, weight: 2.5, opacity: 0.85 };
// The low bucket must stay clearly legible — at 1.4/0.45 a one-off
// multi-day route washed out against OpenTopoMap's own thin blue streams
// and effectively vanished. Frequency reads mostly through weight.
const AGG_BUCKET_STYLES = {
  low:  { color: AGG_COLOR, weight: 2.0, opacity: 0.7 },
  mid:  { color: AGG_COLOR, weight: 2.8, opacity: 0.85 },
  high: { color: AGG_COLOR, weight: 4.0, opacity: 0.95 },
};
function _styleAggFor(feat) {
  return AGG_BUCKET_STYLES[feat?.properties?.bucket] || STYLE_AGG;
}
const STYLE_AGG_DIM_DEFAULT = 0.45;
const STYLE_AGG_DIM_WEIGHT = 2.0;
function _styleAggDim() {
  const el = document.getElementById('dim-opacity');
  const op = el ? Number(el.value) / 100 : STYLE_AGG_DIM_DEFAULT;
  return { color: AGG_COLOR, weight: STYLE_AGG_DIM_WEIGHT, opacity: op };
}
// Match polylines — precise track geometry returned by /match*, drawn on top
// of the aggregate when a click/polygon selects runs.
const STYLE_MATCH_CASING = { color: '#ffffff', weight: 7, opacity: 0.9 };
const STYLE_MATCH = { color: '#d62728', weight: 4.5, opacity: 0.95 };
// Yellow halo for the emphasised row.
const STYLE_HOVER_CASING = { color: '#ffd400', weight: 11, opacity: 0.8 };
const STYLE_HOVER = { color: '#d62728', weight: 5.5, opacity: 1 };
// Translucent red density look for matches without single-row emphasis.
const STYLE_DENSITY_CASING = { color: '#ffffff', weight: 0, opacity: 0 };
const STYLE_DENSITY       = { color: '#d62728', weight: 4.5, opacity: 0.75 };
// When ONE match is emphasised, the others fade further to let the glow lead.
const STYLE_DENSITY_FADED = { color: '#d62728', weight: 3,   opacity: 0.18 };

// Aggregate layers, one L.geoJSON per LOD. Server pre-builds the three
// no-filter variants at ingest, so first paint of any zoom band is warm.
// `aggregateLayers[lod]` is null until the band is first needed; lazy-load
// keyed by current zoom keeps boot to one fetch (the current band) plus
// one fire-and-forget fetch for `high` (used for snap-to-track).
const AGG_LOD_BANDS = [
  { max: 13, lod: 'low'  },  // z 11–13: ~50 m grid
  { max: 15, lod: 'mid'  },  // z 14–15: ~33 m grid (historic default)
  { max: 99, lod: 'high' },  // z 16+:   ~10 m grid
];
const AGG_SNAP_LOD = 'high'; // always snap with the finest LOD, regardless of zoom
function lodForZoom(z) {
  for (const b of AGG_LOD_BANDS) if (z <= b.max) return b.lod;
  return AGG_LOD_BANDS[AGG_LOD_BANDS.length - 1].lod;
}
let aggregateLayers = { low: null, mid: null, high: null };
let aggregateLoads = { low: null, mid: null, high: null };  // in-flight promises
let activeAggLod = null;            // lod currently `addTo(map)`'d, or null
let aggregateSegments = [];         // [[lat,lng],[lat,lng]] pairs (from AGG_SNAP_LOD), for snap-to-track
let indexById = new Map();          // id -> { samples, bbox, type, start_time, distance_m }
let matchLayersById = new Map();    // id -> L.polyline (built per-match render)
let matchCasingsById = new Map();   // id -> L.polyline (white halo)
let matchGeomById = new Map();      // id -> [[lat,lng], ...] (raw, used for re-fit)
let heatmapLayer = null;            // L.heatLayer when overlay is enabled
let heatmapPoints = null;           // [[lat,lng,1], ...] from /heatmap.json
let heatmapFetchInFlight = null;    // de-dupe concurrent fetches
let heatmapClickSuppressed = false; // toggled true while a match is active

let autoMatchedId = null;
let autoMatchSuppressed = false;
let hexLayer = null;
let hexBinsCache = new Map();        // resolution -> Map<cell, count>
let hexCellToActivityIds = new Map();// resolution -> Map<cell, Set<activityId>>
const HEX_ZOOM_THRESHOLD = 11;

// Active filtering
let polygonFilter = null;       // WKT POLYGON, or null
let polygonBounds = null;       // L.latLngBounds of the drawn shape
let prePinView = null;          // map view saved when a track is pinned

// Attribute filters (set by the chip bar). Empty/null means "no filter".
let activeFilters = {
  date_start: null,  // ISO 'YYYY-MM-DD' or null
  date_end: null,    // ISO 'YYYY-MM-DD' or null
  type: null,        // comma-list of 'Run' | 'TrailRun' | 'Hike'; null = all
  min_km: null,      // numbers; null = no bound
  max_km: null,
  gear: null,        // array of shoe names ('' = no shoe); null = all
};

// Hike/walk minimum-distance override (km). null = server default
// (RUN_MAP_HIKE_MIN_KM). A setting rather than a chip filter — it rides on
// every data request and persists in the hash as `hmin`.
let hikeMinKm = null;

function filterQueryString() {
  const p = new URLSearchParams();
  if (activeFilters.date_start) p.set('date_start', activeFilters.date_start);
  if (activeFilters.date_end) p.set('date_end', activeFilters.date_end);
  if (activeFilters.type) p.set('type', activeFilters.type);
  if (activeFilters.min_km != null) p.set('min_km', activeFilters.min_km);
  if (activeFilters.max_km != null) p.set('max_km', activeFilters.max_km);
  if (activeFilters.gear) for (const g of activeFilters.gear) p.append('gear', g);
  if (hikeMinKm != null) p.set('hike_min_km', hikeMinKm);
  return p.toString();
}

function hasActiveFilters() {
  return !!(activeFilters.date_start || activeFilters.date_end || activeFilters.type
            || activeFilters.min_km != null || activeFilters.max_km != null
            || (activeFilters.gear && activeFilters.gear.length));
}

// ---- Persistent view state (URL hash, so views are shareable) -----------

let _restoringState = false;

function _currentHash() {
  const c = map.getCenter();
  const p = new URLSearchParams();
  p.set('z', map.getZoom().toString());
  p.set('ll', `${c.lat.toFixed(5)},${c.lng.toFixed(5)}`);
  if (polygonFilter) p.set('poly', polygonFilter);
  if (activeFilters.date_start) p.set('fds', activeFilters.date_start);
  if (activeFilters.date_end) p.set('fde', activeFilters.date_end);
  if (activeFilters.type) p.set('ftype', activeFilters.type);
  if (hikeMinKm != null) p.set('hmin', hikeMinKm);
  if (activeFilters.min_km != null) p.set('fmin', activeFilters.min_km);
  if (activeFilters.max_km != null) p.set('fmax', activeFilters.max_km);
  if (activeFilters.gear) p.set('fgear', activeFilters.gear.map(encodeURIComponent).join('|'));
  // Settings persistence — only non-default values go on the wire to keep
  // shared URLs short.
  const lock = document.getElementById('lock-to-track');
  if (lock && !lock.checked) p.set('lock', '0');
  const zoomFit = document.getElementById('zoom-to-fit-matches');
  if (zoomFit && zoomFit.checked) p.set('zfit', '1');
  const heat = document.getElementById('heatmap-toggle');
  if (heat && heat.checked) p.set('hm', '1');
  const base = document.getElementById('base-layer');
  if (base && base.value !== 'Topo (OpenTopoMap)') p.set('base', base.value);
  const opacity = document.getElementById('base-opacity');
  if (opacity && opacity.value !== '50') p.set('op', opacity.value);
  const sr = document.getElementById('search-radius');
  if (sr && sr.value !== '0') p.set('sr', sr.value);
  const dim = document.getElementById('dim-opacity');
  if (dim && dim.value !== '45') p.set('dop', dim.value);
  // Persist the active click marker + match-list emphasis so reload restores
  // the user's last interaction (matches + pin + highlighted row).
  if (lastClickLatLng) p.set('cll', `${lastClickLatLng.lat.toFixed(5)},${lastClickLatLng.lng.toFixed(5)}`);
  if (emphasisedId != null) p.set('mid', String(emphasisedId));
  return '#' + p.toString();
}

function saveState() {
  if (_restoringState) return;
  const hash = _currentHash();
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

// Push a new history entry so the *next* state update creates an actual back
// button step. Call this at the start of intentional navigation (hex drill-in,
// preset change, year filter, polygon draw, manual click). Pan/zoom only uses
// replaceState (via saveState) so it doesn't spam history.
function pushHistoryCheckpoint() {
  if (_restoringState) return;
  history.pushState(null, '', _currentHash());
}

function loadSavedState() {
  if (!location.hash || location.hash.length < 2) return null;
  const p = new URLSearchParams(location.hash.slice(1));
  if (![...p.keys()].length) return null;
  const ll = p.get('ll')?.split(',').map(Number);
  return {
    zoom: p.get('z') ? parseInt(p.get('z'), 10) : null,
    center: (ll && ll.length === 2 && !ll.some(isNaN)) ? ll : null,
    polygonFilter: p.get('poly') || null,
    lockToTrack: p.get('lock') !== '0',
    zoomToFit: p.get('zfit') === '1',
    heatmap: p.get('hm') === '1',
    filterDateStart: p.get('fds') || null,
    filterDateEnd: p.get('fde') || null,
    filterType: p.get('ftype') || null,
    hikeMinKm: p.get('hmin') != null ? Number(p.get('hmin')) : null,
    filterMinKm: p.get('fmin') ? Number(p.get('fmin')) : null,
    filterMaxKm: p.get('fmax') ? Number(p.get('fmax')) : null,
    filterGear: p.get('fgear')
      ? p.get('fgear').split('|').map(decodeURIComponent)
      : null,
    baseLayer: p.get('base') || 'Topo (OpenTopoMap)',
    baseOpacity: p.get('op') ? parseInt(p.get('op'), 10) : 50,
    searchRadius: p.get('sr') ? parseInt(p.get('sr'), 10) : 0,
    dimOpacity: p.get('dop') ? parseInt(p.get('dop'), 10) : 45,
    clickLatLng: (() => {
      const v = p.get('cll')?.split(',').map(Number);
      return (v && v.length === 2 && !v.some(isNaN)) ? v : null;
    })(),
    matchId: p.get('mid') ? Number(p.get('mid')) : null,
  };
}
let clickMarker = null;
let clickRadiusCircle = null;
let matchesPanelOpen = false;  // is the top-right matches panel showing?
let lastClickLatLng = null;
let emphasisedId = null;       // id of the row currently visually emphasised
let currentEmphasise = null;   // emphasise fn for the active matches set
let matchesBounds = null;      // saved bbox of last multi-match for "back" fly

let lastMatches = [];

// ---- View presets + year filter -----------------------------------------

function buildTracksQuery() {
  // Presets and polygon are zoom/highlight only; nothing constrains the
  // loaded set right now.
  return '';
}

async function fetchPolygonMatches() {
  if (!polygonFilter) return [];
  const fd = new FormData();
  fd.append('wkt', polygonFilter);
  for (const [k, v] of new URLSearchParams(filterQueryString())) fd.append(k, v);
  const r = await fetch('/match/polygon', { method: 'POST', body: fd });
  return r.ok ? r.json() : [];
}

let polygonCloseBtn = null;
function showPolygonCloseBtn() {
  hidePolygonCloseBtn();
  if (!polygonBounds) return;
  polygonCloseBtn = L.marker(polygonBounds.getNorthEast(), {
    icon: L.divIcon({ className: 'polygon-close-btn', html: '×', iconSize: [26, 26], iconAnchor: [13, 13] }),
    zIndexOffset: 1000, keyboard: false,
  }).addTo(map);
  polygonCloseBtn.on('click', clearPolygonFilter);
}
function hidePolygonCloseBtn() {
  if (polygonCloseBtn) { map.removeLayer(polygonCloseBtn); polygonCloseBtn = null; }
}

async function clearPolygonFilter() {
  pushHistoryCheckpoint();
  polygonFilter = null;
  polygonBounds = null;
  drawnItems.clearLayers();
  hidePolygonCloseBtn();
  clearMatches();
  saveState();
}

// Find the activity with the most recent start_time. Returns null when the
// index is empty or no row has a parseable timestamp.
function _mostRecentActivity() {
  let best = null;
  let bestTs = -Infinity;
  for (const a of indexById.values()) {
    const t = a.start_time ? new Date(a.start_time).getTime() : NaN;
    if (!Number.isFinite(t)) continue;
    if (t > bestTs) { bestTs = t; best = a; }
  }
  return best;
}

function _bboxToBounds(a) {
  // bbox is [minlon, minlat, maxlon, maxlat]
  return [[a.bbox[1], a.bbox[0]], [a.bbox[3], a.bbox[2]]];
}

function flyToLastRun() {
  const a = _mostRecentActivity();
  if (!a) return false;
  map.fitBounds(_bboxToBounds(a), { padding: [30, 30], maxZoom: 16 });
  return true;
}

async function resetToLastRun() {
  pushHistoryCheckpoint();
  autoMatchSuppressed = false;
  // Clear the *visible* match UI: red polylines, matches list, Strava embed.
  // Preserve the click location pin and the in-memory match list selection
  // (`emphasisedId`) — the user explicitly asked for these to survive a reset
  // so they can be restored.
  const savedEmphasised = emphasisedId;
  clearMatchLayers();
  document.getElementById('matches-panel').classList.add('hidden');
  document.getElementById('matches-content').innerHTML = '';
  matchesPanelOpen = false;
  hidePreview();
  lastMatches = [];     // un-block heatmap + visually consistent with the cleared layers
  // Aggregate returns to full prominence; heatmap allowed back.
  if (activeAggLod && aggregateLayers[activeAggLod] && map.hasLayer(aggregateLayers[activeAggLod])) {
    aggregateLayers[activeAggLod].setStyle(_styleAggFor);
  }
  heatmapClickSuppressed = false;
  applyHeatmapVisibility();
  _syncHeatmapToggleEnabled();
  emphasisedId = savedEmphasised;   // restored after hideMatchesPanel would've nulled it
  flyToLastRun();
  applyZoomMode();
  saveState();
}

// ---- Auto match radius (scales with zoom) --------------------------------

// Click forgiveness in screen pixels. We translate this into metres at the
// current zoom + latitude, so the match radius always reflects what looks
// "close" on the map.
const CLICK_PIXEL_TOLERANCE = 22;

function metresPerPixel(zoom, lat) {
  return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom + 8);
}

function currentRadiusMetres() {
  // Manual override from the settings slider (0 = auto).
  const slider = document.getElementById('search-radius');
  if (slider) {
    const v = parseInt(slider.value, 10);
    if (v > 0) return v;
  }
  const c = map.getCenter();
  const m = metresPerPixel(map.getZoom(), c.lat) * CLICK_PIXEL_TOLERANCE;
  return Math.max(5, Math.min(2000, Math.round(m)));
}

// Match radius is still used for the query, but no longer surfaced as UI.

// ---- Data load -----------------------------------------------------------
//
// Boot fetches two compact files instead of every track:
//   /index.json        — per-activity bbox + samples + metadata (for hex
//                        aggregation, view-fit, auto-match, heatmap)
//   /aggregate.geojson — one dedup'd MultiLineString of every road/trail
//                        you've ever run (the "where can I click" layer)
//
// Precise per-track geometry now arrives inline on /match responses, so
// the bulk track set never needs to be loaded.

function setBgStatus(text) {
  const el = document.getElementById('bg-status');
  if (!text) { el.classList.add('hidden'); return; }
  el.textContent = text;
  el.classList.remove('hidden');
}

async function loadData() {
  showSpinner('Loading map…');
  try {
    await Promise.all([loadIndex(), loadAggregate()]);
  } finally {
    hideSpinner();
  }
}

async function loadIndex() {
  const qs = filterQueryString();
  const r = await fetch(`/index.json${qs ? `?${qs}` : ''}`);
  if (!r.ok) return false;
  const data = await r.json();
  indexById.clear();
  hexBinsCache.clear();
  hexCellToActivityIds.clear();
  for (const a of data.activities || []) {
    indexById.set(a.id, a);
  }
  return true;
}

function _clearAggregateLayers() {
  for (const lod of Object.keys(aggregateLayers)) {
    const layer = aggregateLayers[lod];
    if (layer && map.hasLayer(layer)) map.removeLayer(layer);
    aggregateLayers[lod] = null;
    aggregateLoads[lod] = null;
  }
  activeAggLod = null;
  aggregateSegments = [];
}

// Fetch + parse one LOD off-map: returns { layer, segs } (segs only for the
// snap LOD) or null. Doesn't touch any shared state, so callers decide when
// (and whether) the result becomes live.
async function _buildAggLod(lod) {
  const qs = filterQueryString();
  const url = `/aggregate.geojson?lod=${lod}${qs ? `&${qs}` : ''}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const gj = await r.json();
  const feat = gj.features?.[0];
  if (!feat || !feat.geometry) return null;
  let segs = null;
  if (lod === AGG_SNAP_LOD) {
    segs = [];
    for (const f of gj.features) {
      for (const seg of f.geometry.coordinates || []) {
        if (seg.length >= 2) {
          segs.push([[seg[0][1], seg[0][0]], [seg[1][1], seg[1][0]]]);
        }
      }
    }
  }
  const layer = L.geoJSON(gj, { style: _styleAggFor, interactive: false, renderer: aggRenderer, pane: 'aggPane' });
  return { layer, segs };
}

// Lazy-load one LOD into the live store. Idempotent: a second call with the
// same lod awaits the in-flight promise instead of refetching.
function ensureAggLod(lod) {
  if (aggregateLayers[lod]) return Promise.resolve(aggregateLayers[lod]);
  if (aggregateLoads[lod]) return aggregateLoads[lod];
  const p = (async () => {
    const built = await _buildAggLod(lod);
    if (!built) return null;
    if (built.segs) aggregateSegments = built.segs;
    aggregateLayers[lod] = built.layer;
    return built.layer;
  })();
  aggregateLoads[lod] = p;
  return p;
}

// Reload counter: a slow reload that has been superseded by a newer one (or
// by another _clearAggregateLayers-triggering path) must throw its result
// away instead of installing stale data.
let _aggReloadGen = 0;

async function loadAggregate() {
  // Build the new layers OFF-map first — the old aggregate stays visible and
  // clickable during the fetch+parse (seconds on a big library) — and swap
  // only when everything is ready.
  const gen = ++_aggReloadGen;
  const current = lodForZoom(map.getZoom());
  const lods = current !== AGG_SNAP_LOD ? [current, AGG_SNAP_LOD] : [current];
  const built = await Promise.all(lods.map(lod => _buildAggLod(lod)));
  if (gen !== _aggReloadGen) return false;  // superseded — discard
  _clearAggregateLayers();
  built.forEach((b, i) => {
    if (!b) return;
    aggregateLayers[lods[i]] = b.layer;
    if (b.segs) aggregateSegments = b.segs;
  });
  // Reattach immediately so there's no blank frame between clear and the
  // caller's applyZoomMode.
  applyZoomMode();
  return !!aggregateLayers[current];
}


// ---- Hex (low-zoom) overlay ---------------------------------------------

function resolutionForZoom(z) {
  if (z < 3) return 1;
  if (z < 5) return 2;
  if (z < 7) return 3;
  if (z < 9) return 4;
  return 5;
}

function getHexBins(res) {
  if (hexBinsCache.has(res)) return hexBinsCache.get(res);
  const counts = new Map();
  const cellToIds = new Map();
  if (!window.h3) {
    hexBinsCache.set(res, counts);
    hexCellToActivityIds.set(res, cellToIds);
    return counts;
  }
  for (const [id, a] of indexById) {
    const cells = new Set();
    for (const [lat, lng] of a.samples) cells.add(h3.latLngToCell(lat, lng, res));
    for (const c of cells) {
      counts.set(c, (counts.get(c) || 0) + 1);
      let s = cellToIds.get(c);
      if (!s) { s = new Set(); cellToIds.set(c, s); }
      s.add(id);
    }
  }
  hexBinsCache.set(res, counts);
  hexCellToActivityIds.set(res, cellToIds);
  return counts;
}

function boundsOfTracksInHex(res, cell) {
  const ids = hexCellToActivityIds.get(res)?.get(cell);
  if (!ids || !ids.size) return null;
  let bounds = null;
  for (const id of ids) {
    const a = indexById.get(id);
    if (!a) continue;
    // bbox = [minlon, minlat, maxlon, maxlat]
    const b = L.latLngBounds([a.bbox[1], a.bbox[0]], [a.bbox[3], a.bbox[2]]);
    bounds = bounds ? bounds.extend(b) : L.latLngBounds(b.getSouthWest(), b.getNorthEast());
  }
  return bounds;
}

function colorFor(t) {
  // Compress raw t into a 0.35..1.0 range so cells with 1-2 runs are still
  // visible against the basemap, while heavily-traversed cells stay deep red.
  const adj = 0.35 + 0.65 * t;
  const r = Math.round(255 + (214 - 255) * adj);
  const g = Math.round(255 + (39 - 255) * adj);
  const b = Math.round(255 + (40 - 255) * adj);
  return `rgb(${r},${g},${b})`;
}

function renderHexes() {
  if (hexLayer) { map.removeLayer(hexLayer); hexLayer = null; }
  if (!indexById.size || !window.h3) return;
  const res = resolutionForZoom(map.getZoom());
  const counts = getHexBins(res);
  if (!counts.size) return;

  const maxCount = Math.max(...counts.values());
  const features = [];
  for (const [cell, count] of counts) {
    const boundary = h3.cellToBoundary(cell, true); // [lng, lat] for GeoJSON
    features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [boundary] },
      properties: { count, cell },
    });
  }

  hexLayer = L.geoJSON({ type: 'FeatureCollection', features }, {
    style: f => {
      const t = Math.log(f.properties.count + 1) / Math.log(maxCount + 1);
      return {
        fillColor: colorFor(t),
        fillOpacity: 0.7,
        color: '#ffffff',
        weight: 1,
        opacity: 0.9,
      };
    },
    onEachFeature: (feat, layer) => {
      const n = feat.properties.count;
      layer.bindTooltip(`${n} activit${n === 1 ? 'y' : 'ies'}`, { sticky: true, opacity: 0.9 });
      layer.on('mouseover', () => layer.setStyle({ weight: 2, color: '#222' }));
      layer.on('mouseout',  () => layer.setStyle({ weight: 0.6, color: '#ffffff' }));
      layer.on('click', e => {
        L.DomEvent.stopPropagation(e);
        pushHistoryCheckpoint();
        // Zoom to the hex itself — using the tracks' bounding box surprised
        // users when the contained tracks extend well beyond the hex outline
        // (or when a long track's bbox dwarfs the cell). But land at least
        // in track view: fitting a coarse hex's own bounds stops short of
        // the threshold and reads as "the click did nothing".
        const b = layer.getBounds();
        const fitZoom = map.getBoundsZoom(b, false, L.point(40, 40));
        const target = Math.min(Math.max(fitZoom, HEX_ZOOM_THRESHOLD), 16);
        map.flyTo(b.getCenter(), target, { duration: 0.7 });
      });
    },
  }).addTo(map);
}

function _detachAggregate() {
  if (activeAggLod && aggregateLayers[activeAggLod] && map.hasLayer(aggregateLayers[activeAggLod])) {
    map.removeLayer(aggregateLayers[activeAggLod]);
  }
  activeAggLod = null;
}

function _currentAggStyle() {
  // Dim (uniform) when a match is active, otherwise the per-bucket worn-path
  // look. Returned as a style function so setStyle re-evaluates per feature.
  if (lastMatches && lastMatches.length) {
    const dim = _styleAggDim();
    return () => dim;
  }
  return _styleAggFor;
}

// Swap to the LOD for the current zoom. Lazy-loads if the band hasn't been
// fetched yet; once the fetch resolves we re-check the current zoom so a
// fast scroller doesn't end up showing a stale LOD.
function _swapAggregateToZoom() {
  const want = lodForZoom(map.getZoom());
  if (activeAggLod === want && aggregateLayers[want]) return;
  const layer = aggregateLayers[want];
  if (layer) {
    if (activeAggLod && activeAggLod !== want) {
      const prev = aggregateLayers[activeAggLod];
      if (prev && map.hasLayer(prev)) map.removeLayer(prev);
    }
    layer.setStyle(_currentAggStyle());
    if (!map.hasLayer(layer)) layer.addTo(map);
    activeAggLod = want;
    return;
  }
  ensureAggLod(want).then(l => {
    if (!l) return;
    // Re-check: user may have zoomed again while the fetch was in flight.
    if (lodForZoom(map.getZoom()) !== want) return;
    // Hex mode may have taken over too.
    if (map.getZoom() < HEX_ZOOM_THRESHOLD && window.h3) return;
    if (activeAggLod && activeAggLod !== want) {
      const prev = aggregateLayers[activeAggLod];
      if (prev && map.hasLayer(prev)) map.removeLayer(prev);
    }
    l.setStyle(_currentAggStyle());
    if (!map.hasLayer(l)) l.addTo(map);
    activeAggLod = want;
  });
}

function applyZoomMode() {
  // "All tracks hidden" (every type pill off) wins over zoom: without this
  // guard a zoomend would re-render hexes or re-attach the aggregate.
  if (_allTypesOff) {
    if (hexLayer) { map.removeLayer(hexLayer); hexLayer = null; }
    _detachAggregate();
    if (heatmapLayer && map.hasLayer(heatmapLayer)) map.removeLayer(heatmapLayer);
    return;
  }
  // If h3-js failed to load, never go into hex mode — just show aggregate.
  const useTracks = map.getZoom() >= HEX_ZOOM_THRESHOLD || !window.h3;
  if (useTracks) {
    if (hexLayer) { map.removeLayer(hexLayer); hexLayer = null; }
    _swapAggregateToZoom();
    applyHeatmapVisibility();
  } else {
    _detachAggregate();
    if (heatmapLayer && map.hasLayer(heatmapLayer)) map.removeLayer(heatmapLayer);
    renderHexes();
    // Hex view is for density only — track-level interactions don't apply.
    clearClickGraphics();
    hideMatchesPanel();
    clearMatchLayers();
  }
}

map.on('zoomend', applyZoomMode);

// ---- Spatial queries -----------------------------------------------------

async function queryPoint(lat, lon) {
  const p = new URLSearchParams({ lat, lon, r: currentRadiusMetres() });
  const qs = filterQueryString();
  if (qs) for (const [k, v] of new URLSearchParams(qs)) p.set(k, v);
  const r = await fetch(`/match?${p.toString()}`);
  const matches = await r.json();
  lastClickLatLng = L.latLng(lat, lon);
  lastMatches = matches;
  // Ensure the click pin + radius circle reflect the (lat,lon) we just queried —
  // important on URL-state restore where no click event drew them.
  if (!clickMarker || !clickMarker.getLatLng().equals(lastClickLatLng)) {
    drawClickGraphics(lastClickLatLng, currentRadiusMetres());
  }
  renderMatches(matches, lastClickLatLng);
  // Persist the click marker + match selection so reload restores them.
  saveState();
}

async function queryPolygon(wkt) {
  const fd = new FormData();
  fd.append('wkt', wkt);
  for (const [k, v] of new URLSearchParams(filterQueryString())) fd.append(k, v);
  const r = await fetch('/match/polygon', { method: 'POST', body: fd });
  renderMatches(await r.json());
}

function clearMatchLayers() {
  for (const layer of matchLayersById.values()) map.removeLayer(layer);
  for (const layer of matchCasingsById.values()) map.removeLayer(layer);
  matchLayersById.clear();
  matchCasingsById.clear();
  matchGeomById.clear();
}

function buildMatchLayers(matches) {
  clearMatchLayers();
  for (const m of matches) {
    if (!m.geometry || m.geometry.length < 2) continue;
    matchGeomById.set(m.id, m.geometry);
    const casing = L.polyline(m.geometry, { ...STYLE_DENSITY_CASING, renderer: matchRenderer, pane: 'matchPane' });
    const line = L.polyline(m.geometry, { ...STYLE_DENSITY, renderer: matchRenderer, pane: 'matchPane' });
    line.on('mouseover', () => { map.getContainer().style.cursor = 'pointer'; });
    line.on('mouseout',  () => { map.getContainer().style.cursor = ''; });
    matchCasingsById.set(m.id, casing);
    matchLayersById.set(m.id, line);
    casing.addTo(map);
    line.addTo(map);
  }
}

// Strava's own activity icons (Run / TrailRun) plus a hiker for Hike/Walk, inlined.
const ICON_ROAD = `<svg class="ti road" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><title>Road run</title><path fill="currentColor" d="M8.688 0C8.025 0 7.38.215 6.85.613l-3.32 2.49-2.845.948A1 1 0 000 5c0 1.579.197 2.772.567 3.734.376.978.907 1.654 1.476 2.223.305.305.6.567.886.82.785.697 1.5 1.33 2.159 2.634 1.032 2.57 2.37 4.748 4.446 6.27C11.629 22.218 14.356 23 18 23c2.128 0 3.587-.553 4.549-1.411a4.378 4.378 0 001.408-2.628c.152-.987-.389-1.787-.967-2.25l-3.892-3.114a1 1 0 01-.329-.477l-3.094-9.726A2 2 0 0013.769 2h-1.436a2 2 0 00-1.2.4l-.57.428-.516-1.803A1.413 1.413 0 008.688 0zM8.05 2.213c.069-.051.143-.094.221-.127l1.168 4.086L12.333 4h1.436l.954 3H12v2h3.36l.318 1H13v2h3.314l.55 1.726a3 3 0 00.984 1.433l3.106 2.485c-.77.19-1.778.356-2.954.356-1.97 0-3.178-.431-4.046-1.087-.895-.677-1.546-1.675-2.251-3.056-.224-.437-.45-.907-.688-1.403C9.875 10.08 8.444 7.1 5.531 4.102zM3.743 5.14c2.902 2.858 4.254 5.664 5.441 8.126.25.517.49 1.018.738 1.502.732 1.432 1.55 2.777 2.827 3.74C14.053 19.495 15.72 20 18 20c1.492 0 2.754-.23 3.684-.479a2.285 2.285 0 01-.467.575c-.5.446-1.435.904-3.217.904-3.356 0-5.629-.718-7.284-1.931-1.663-1.22-2.823-3.028-3.788-5.44a1.012 1.012 0 00-.034-.076c-.853-1.708-1.947-2.673-2.79-3.417a14.61 14.61 0 01-.647-.593c-.431-.431-.775-.88-1.024-1.527-.21-.545-.367-1.271-.417-2.3z"/></svg>`;
const ICON_TRAIL = `<svg class="ti trail" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><title>Trail run</title><path fill="currentColor" d="M8.688 0C8.025 0 7.38.215 6.85.613l-3.32 2.49-2.845.948A1 1 0 000 5c0 1.579.197 2.772.567 3.734.376.978.907 1.654 1.476 2.223.305.305.6.567.886.82.785.697 1.5 1.33 2.159 2.634 1.032 2.57 2.37 4.748 4.446 6.27.15.11.303.217.46.319h-2.58l-2.707-2.707a1 1 0 00-1.414 0L3 18.586l-1.5-1.5L.086 18.5l2.207 2.207a1 1 0 001.414 0L4 20.414l2.293 2.293A1 1 0 007 23h11c2.128 0 3.587-.553 4.549-1.411a4.378 4.378 0 001.408-2.628c.152-.987-.389-1.787-.967-2.25l-3.892-3.114a1 1 0 01-.329-.477l-3.094-9.726A2 2 0 0013.769 2h-1.436a2 2 0 00-1.2.4l-.57.428-.516-1.803A1.413 1.413 0 008.688 0zM18 21c-3.356 0-5.629-.718-7.284-1.931-1.663-1.22-2.823-3.028-3.788-5.44a1.012 1.012 0 00-.034-.076c-.853-1.708-1.947-2.673-2.79-3.417-.24-.212-.46-.405-.647-.593-.431-.431-.775-.88-1.024-1.527-.21-.545-.367-1.271-.417-2.3l1.323-.442L5 7.351v1.706l.333.299c1.11.992 2.452 2.512 3.933 4.839 1.356 2.132 3.156 3.553 5.26 4.685l.222.12h7.156c-.105.36-.307.758-.687 1.096-.5.446-1.435.904-3.217.904zM5.175 4.368L8.05 2.213c.069-.051.143-.094.221-.127l1.168 4.086L12.333 4h1.436l.954 3H10v1.934l3.11 3.391-.724 1.014L13.454 15h4.21c.06.055.12.108.184.16L20.15 17h-4.893c-1.793-.996-3.223-2.182-4.303-3.88C9.526 10.88 8.188 9.295 7 8.172V6.65zM15.36 9l.039.122-1.1 1.54L12.774 9zm.796 2.502L16.632 13h-1.546z"/></svg>`;

const ICON_HIKE = `<svg class="ti hike" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><title>Hike</title><path fill="currentColor" d="M13.5 5.5c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zM17.5 10.78c-1.23-.37-2.22-1.17-2.8-2.18l-1-1.6c-.41-.65-1.11-1-1.84-1-.78 0-1.59.5-1.78 1.44S7 23 7 23h2.1l1.8-8 2.1 2v6h2v-7.5l-2.1-2 .6-3c1 1.15 2.41 2.01 4 2.34V23H19V9h-1.5v1.78zM7.43 13.13l-2.12-.41c-.54-.11-1.07.25-1.18.79l-.12.59c-.11.54.25 1.07.79 1.18l2.12.41c.54.11 1.07-.25 1.18-.79l.12-.59c.1-.55-.26-1.07-.79-1.18z"/></svg>`;

// The registry every type-aware surface reads from: pills, match-row icons,
// tooltips, and the stats chart. Order here is the canonical UI order used
// when serialising a comma-list type filter.
const TYPE_DEFS = [
  { type: 'Run',      label: 'Road',  color: '#1f77b4', icon: ICON_ROAD },
  { type: 'TrailRun', label: 'Trail', color: '#16a34a', icon: ICON_TRAIL },
  { type: 'Hike',     label: 'Hike',  color: '#d97706', icon: ICON_HIKE },
];
const ALL_TYPES = TYPE_DEFS.map(d => d.type);

function typeIcon(type) {
  const def = TYPE_DEFS.find(d => d.type === type);
  return def ? def.icon : '';
}

function rowHtml(m) {
  const date = m.start_time ? m.start_time.slice(0, 10) : '?';
  const km = ((m.distance_m || 0) / 1000).toFixed(1);
  const name = m.name || '(unnamed)';
  const url = m.strava_url;
  return `<tr data-id="${m.id}">
    <td class="type">${typeIcon(m.activity_type)}</td>
    <td class="date"><a href="${url}" target="_blank" rel="noopener">${date}</a></td>
    <td class="dist"><a href="${url}" target="_blank" rel="noopener">${km} km</a></td>
    <td class="name"><a href="#" class="open-preview" data-id="${m.id}"${m.description ? ` title="${escapeHTML(m.description)}"` : ''}>${escapeHTML(name)}</a></td>
  </tr>`;
}

function bindMatchTooltips(matches) {
  for (const m of matches) {
    const layer = matchLayersById.get(m.id);
    if (!layer) continue;
    const date = m.start_time ? m.start_time.slice(0, 10) : '?';
    const km = ((m.distance_m || 0) / 1000).toFixed(1);
    const name = escapeHTML(m.name || '(unnamed)');
    const icon = typeIcon(m.activity_type);
    const extras = [];
    if (m.gear) extras.push(`👟 ${escapeHTML(m.gear)}`);
    if (m.elevation_gain_m != null) extras.push(`↗ ${Math.round(m.elevation_gain_m)} m`);
    if (m.avg_hr != null) extras.push(`♥ ${Math.round(m.avg_hr)}`);
    const extraLine = extras.length
      ? `<br><span style="color:#666">${extras.join(' · ')}</span>` : '';
    layer.bindTooltip(
      `${icon} <strong>${date}</strong> · ${km} km<br><span style="color:#666">${name}</span>${extraLine}`,
      { sticky: true, direction: 'top', opacity: 0.95 }
    );
  }
}

function renderMatches(matches, atLatLng, { fit = true } = {}) {
  hideMatchesPanel();
  hidePreview();
  lastMatches = matches;

  // Build per-match polylines from the inline geometry that /match* returns,
  // then style them as the active density layer.
  buildMatchLayers(matches);
  applyMatchViewMode(matches);
  // Aggregate dims behind active matches so the red lines stand out.
  if (activeAggLod && aggregateLayers[activeAggLod] && map.hasLayer(aggregateLayers[activeAggLod])) {
    aggregateLayers[activeAggLod].setStyle(_styleAggDim());
  }
  // Heatmap is exploratory — hide it while the user is looking at a match.
  heatmapClickSuppressed = true;
  applyHeatmapVisibility();
  _syncHeatmapToggleEnabled();

  if (!matches.length) {
    matchesPanelOpen = true;
    document.getElementById('matches-content').innerHTML =
      '<p class="muted" style="margin:4px 0">No tracks here at this radius.</p>';
    document.getElementById('matches-panel').classList.remove('hidden');
    return;
  }

  // Combined bounds — remembered for the "fly back" when a pinned preview
  // closes. Only the explicit "zoom to fit matches" setting causes a zoom on
  // click; by default the view is left alone.
  let b = null;
  for (const m of matches) {
    const layer = matchLayersById.get(m.id);
    if (!layer) continue;
    const lb = layer.getBounds();
    b = b ? b.extend(lb) : L.latLngBounds(lb.getSouthWest(), lb.getNorthEast());
  }
  if (b && atLatLng) b.extend(atLatLng);
  matchesBounds = (matches.length > 1 && b) ? b : null;
  const zoomToFit = document.getElementById('zoom-to-fit-matches')?.checked;
  if (fit && b && zoomToFit) {
    map.flyToBounds(b, { padding: [10, 10], maxZoom: 18, duration: 0.6 });
  }

  // Single match: skip the table, the layer tooltip, and just auto-show the
  // rich preview.
  if (matches.length === 1) {
    scheduleStravaPreview(matches[0].id, { delay: 0 });
    return;
  }

  // Multiple matches: show the table in the top-right panel, with layer
  // tooltips so each red line is identifiable from the map alone.
  bindMatchTooltips(matches);
  // Header answers "when?" before the user scrolls a single row: count and
  // first→last span. Year separator rows keep hundreds of rows scannable
  // (matches arrive newest-first from the server).
  const stamps = matches.map(m => m.start_time).filter(Boolean).sort();
  const span = stamps.length
    ? ` · ${stamps[0].slice(0, 7)} → ${stamps[stamps.length - 1].slice(0, 7)}`
    : '';
  const summary = `<div class="matches-summary"><strong>${matches.length}</strong> matches${span} · newest first</div>`;
  let lastYear = null;
  const rows = [];
  for (const m of matches) {
    const year = m.start_time ? m.start_time.slice(0, 4) : '?';
    if (year !== lastYear) {
      rows.push(`<tr class="year-sep"><td colspan="4">${year}</td></tr>`);
      lastYear = year;
    }
    rows.push(rowHtml(m));
  }
  const html = `${summary}<table class="matches-table"><tbody>${rows.join('')}</tbody></table>`;
  const content = document.getElementById('matches-content');
  content.innerHTML = html;
  document.getElementById('matches-panel').classList.remove('hidden');
  matchesPanelOpen = true;

  function emphasise(id, { force = false } = {}) {
    if (!force && previewActivityId != null) return;
    if (emphasisedId === id) return;
    emphasisedId = id;
    for (const m of matches) {
      const ol = matchLayersById.get(m.id);
      const oc = matchCasingsById.get(m.id);
      if (!ol) continue;
      if (id == null) {
        if (oc) oc.setStyle(STYLE_DENSITY_CASING);
        ol.setStyle(STYLE_DENSITY);
      } else if (m.id === id) {
        if (oc) { oc.setStyle(STYLE_HOVER_CASING); oc.bringToFront(); }
        ol.setStyle(STYLE_HOVER); ol.bringToFront();
      } else {
        if (oc) oc.setStyle(STYLE_DENSITY_CASING);
        ol.setStyle(STYLE_DENSITY_FADED);
      }
    }
    content.querySelectorAll('tr[data-id]').forEach(tr => {
      tr.classList.toggle('emphasised', id != null && parseInt(tr.dataset.id, 10) === id);
    });
  }
  // Expose so the row-title click path can call it.
  currentEmphasise = emphasise;

  content.querySelectorAll('tr[data-id]').forEach(tr => {
    const id = parseInt(tr.dataset.id, 10);
    tr.addEventListener('mouseenter', () => emphasise(id));
  });
  content.querySelectorAll('a.open-preview').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      const id = parseInt(a.dataset.id, 10);
      // Remember where we were so closing the preview can restore it.
      prePinView = { center: map.getCenter(), zoom: map.getZoom() };
      emphasise(id, { force: true });
      scheduleStravaPreview(id, { delay: 0 });
      const layer = matchLayersById.get(id);
      if (layer) {
        // Pin should frame the whole track AND the original search point,
        // so the click marker + radius circle stay visible.
        const b = L.latLngBounds(layer.getBounds().getSouthWest(), layer.getBounds().getNorthEast());
        if (clickMarker) b.extend(clickMarker.getLatLng());
        if (clickRadiusCircle) b.extend(clickRadiusCircle.getBounds());
        map.flyToBounds(b, { padding: [20, 20], maxZoom: 17, duration: 0.6 });
      }
    });
  });
}

function hideMatchesPanel() {
  matchesPanelOpen = false;
  emphasisedId = null;
  document.getElementById('matches-panel').classList.add('hidden');
  document.getElementById('matches-content').innerHTML = '';
}

function applyMatchViewMode(matches) {
  // Match layers were freshly built by buildMatchLayers — style them all
  // with the density look so overlapping matches darken naturally.
  for (const [, layer] of matchLayersById) layer.setStyle(STYLE_DENSITY);
  for (const [, casing] of matchCasingsById) casing.setStyle(STYLE_DENSITY_CASING);
  for (const [, layer] of matchLayersById) layer.bringToFront();
  // Re-apply current emphasis (if any) on top of the freshly-styled set.
  const ids = new Set(matches.map(m => m.id));
  if (emphasisedId != null && ids.has(emphasisedId) && currentEmphasise) {
    const e = emphasisedId; emphasisedId = null;  // force re-paint
    currentEmphasise(e, { force: true });
  }
}

function clearMatches() {
  hideMatchesPanel();
  lastMatches = [];
  matchesBounds = null;
  prePinView = null;
  _filteredMatchActive = false;
  clearMatchLayers();
  hidePreview();
  // Aggregate returns to full prominence once nothing is matched.
  if (activeAggLod && aggregateLayers[activeAggLod] && map.hasLayer(aggregateLayers[activeAggLod])) {
    aggregateLayers[activeAggLod].setStyle(_styleAggFor);
  }
  // Heatmap was hidden while match was active — restore if toggle is on.
  heatmapClickSuppressed = false;
  applyHeatmapVisibility();
  _syncHeatmapToggleEnabled();
}

// Heatmap is mutually exclusive with active matches — grey the toggle out
// (and its label) so the user gets visual feedback for why it's inert.
function _syncHeatmapToggleEnabled() {
  const cb = document.getElementById('heatmap-toggle');
  if (!cb) return;
  const blocked = !!(lastMatches && lastMatches.length);
  cb.disabled = blocked;
  const label = cb.closest('label');
  if (label) label.classList.toggle('disabled', blocked);
}

// ---- Lock-to-track (snap click to nearest track) -------------------------

function pointToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a.x + t * dx, y = a.y + t * dy;
  const ddx = p.x - x, ddy = p.y - y;
  return { dist: Math.sqrt(ddx * ddx + ddy * ddy), x, y };
}

function snapToNearestTrack(clickLatLng, maxPixels = 30) {
  // Snap against the aggregate segments — those are every road/trail you've
  // ever run, deduped, so they're the right thing to "lock" the click to.
  if (!aggregateSegments.length) return null;
  const cp = map.latLngToLayerPoint(clickLatLng);
  let best = null;
  for (const [a, b] of aggregateSegments) {
    const pa = map.latLngToLayerPoint(L.latLng(a[0], a[1]));
    const pb = map.latLngToLayerPoint(L.latLng(b[0], b[1]));
    const r = pointToSegment(cp, pa, pb);
    if (!best || r.dist < best.dist) best = r;
  }
  if (best && best.dist <= maxPixels) {
    return map.layerPointToLatLng(L.point(best.x, best.y));
  }
  return null;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---- Spinner ------------------------------------------------------------

let _spinDepth = 0;
function showSpinner(label = 'Loading…') {
  _spinDepth++;
  document.getElementById('spinner-label').textContent = label;
  if (_spinDepth === 1) document.getElementById('spinner').classList.remove('hidden');
}
function updateSpinner(label) {
  if (_spinDepth > 0) document.getElementById('spinner-label').textContent = label;
}
function hideSpinner() {
  _spinDepth = Math.max(0, _spinDepth - 1);
  if (_spinDepth === 0) document.getElementById('spinner').classList.add('hidden');
}

// ---- Toast --------------------------------------------------------------

let toastTimer = null;
function showToast(html, timeoutMs = 6000) {
  const t = document.getElementById('toast');
  document.getElementById('toast-text').innerHTML = html;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  if (timeoutMs > 0) {
    toastTimer = setTimeout(() => t.classList.add('hidden'), timeoutMs);
  }
}
function hideToast() {
  clearTimeout(toastTimer);
  document.getElementById('toast').classList.add('hidden');
}
document.getElementById('toast-close').onclick = hideToast;

// ---- Native activity preview (hover row → API-driven card) --------------

const activityCache = new Map();        // id -> { summary, streams }
let previewTimer = null;
let previewActivityId = null;

async function fetchActivity(id) {
  if (activityCache.has(id)) return activityCache.get(id);
  const r = await fetch(`/activity/${id}`);
  if (!r.ok) throw new Error(await r.text() || `HTTP ${r.status}`);
  const data = await r.json();
  activityCache.set(id, data);
  return data;
}

function scheduleStravaPreview(id, { delay = 350 } = {}) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    if (previewActivityId === id) return;
    previewActivityId = id;
    const panel = document.getElementById('preview-panel');
    const content = document.getElementById('preview-content');
    content.innerHTML = '<p class="muted" style="margin:8px 0">Loading…</p>';
    panel.classList.remove('hidden');
    try {
      const data = await fetchActivity(id);
      if (previewActivityId !== id) return;
      content.innerHTML = renderPreview(data);
      _wirePreviewSwipe();
    } catch (e) {
      if (previewActivityId !== id) return;
      content.innerHTML = `<p class="status error">Preview unavailable: ${escapeHTML(String(e.message || e))}</p>`;
    }
  }, delay);
}

// Preview is sticky now — it only closes on × or when the highlight ends.
function scheduleStravaPreviewHide() { /* no-op */ }

function hidePreview() {
  clearTimeout(previewTimer);
  previewActivityId = null;
  document.getElementById('preview-panel').classList.add('hidden');
}

// User-clicked × on the preview: hide, release the emphasis pin, and fly
// back to wherever the user was before pinning.
document.getElementById('preview-close').onclick = () => {
  hidePreview();
  if (currentEmphasise) currentEmphasise(null, { force: true });
  if (prePinView) {
    map.flyTo(prePinView.center, prePinView.zoom, { duration: 0.6 });
    prePinView = null;
  }
};

function fmtTime(sec) {
  if (!sec) return '?';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtPace(distanceM, timeSec) {
  if (!distanceM || !timeSec) return '?';
  const minPerKm = (timeSec / 60) / (distanceM / 1000);
  const m = Math.floor(minPerKm);
  const s = Math.round((minPerKm - m) * 60);
  return `${m}:${String(s).padStart(2, '0')}/km`;
}

function renderElevationChart(streams) {
  const dist = streams?.distance?.data;
  const alt = streams?.altitude?.data;
  if (!dist || !alt || dist.length < 2) return '';
  const n = Math.min(dist.length, alt.length);
  const target = 180;
  const step = Math.max(1, Math.floor(n / target));
  const pts = [];
  for (let i = 0; i < n; i += step) pts.push([dist[i], alt[i]]);

  const w = 308, h = 60;
  const minA = Math.min(...pts.map(p => p[1]));
  const maxA = Math.max(...pts.map(p => p[1]));
  const maxD = pts[pts.length - 1][0] || 1;
  const range = (maxA - minA) || 1;

  const d = pts.map((p, i) => {
    const x = (p[0] / maxD) * w;
    const y = h - ((p[1] - minA) / range) * h;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');

  return `
    <svg class="elev-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <path d="${d} L${w} ${h} L0 ${h} Z" fill="#1f77b4" fill-opacity="0.18"/>
      <path d="${d}" stroke="#1f77b4" fill="none" stroke-width="1.4"/>
      <text x="3" y="10" font-size="9" fill="#666">${Math.round(maxA)} m</text>
      <text x="3" y="${h - 3}" font-size="9" fill="#666">${Math.round(minA)} m</text>
    </svg>`;
}

function renderPreview({ summary, streams }) {
  const date = (summary.start_date_local || '').slice(0, 16).replace('T', ' ');
  const km = summary.distance ? (summary.distance / 1000).toFixed(2) + ' km' : '?';
  const time = fmtTime(summary.moving_time);
  const pace = fmtPace(summary.distance, summary.moving_time);
  const elev = summary.total_elevation_gain != null ? `↑ ${Math.round(summary.total_elevation_gain)} m` : '?';
  const hr = summary.has_heartrate ? `${Math.round(summary.average_heartrate)} bpm` : null;
  const photo = summary.photos?.primary?.urls?.['600'] || summary.photos?.primary?.urls?.['100'];
  const kudos = summary.kudos_count ?? 0;
  const comments = summary.comment_count ?? 0;

  // Two-page swipeable layout on mobile: page 1 is the details + elevation,
  // page 2 is the photo. CSS scroll-snap drives the gesture; on desktop the
  // pages just stack vertically. With no photo we skip the second page and
  // the dots so the popup stays compact.
  const detailsPage = `
    <section class="preview-page details">
      <a class="preview-link top" href="https://www.strava.com/activities/${summary.id}" target="_blank" rel="noopener">Open on Strava ↗</a>
      <h3>${escapeHTML(summary.name || '(unnamed)')}</h3>
      <p class="pdate">${escapeHTML(date)} · ${escapeHTML(summary.type || '')}</p>
      <p class="social">👍 ${kudos} &nbsp;·&nbsp; 💬 ${comments}</p>
      <table class="stats">
        <tr><td>Distance</td><td>${km}</td></tr>
        <tr><td>Moving time</td><td>${time}</td></tr>
        <tr><td>Pace</td><td>${pace}</td></tr>
        <tr><td>Elevation</td><td>${elev}</td></tr>
        ${hr ? `<tr><td>Avg HR</td><td>${hr}</td></tr>` : ''}
      </table>
      ${renderElevationChart(streams)}
    </section>`;
  const photoPage = photo
    ? `<section class="preview-page photo"><img class="preview-photo" src="${photo}" alt=""></section>`
    : '';
  const dots = photo
    ? `<div class="preview-dots" aria-hidden="true"><span class="dot on"></span><span class="dot"></span></div>`
    : '';
  return `
    <div class="preview-pages">${detailsPage}${photoPage}</div>
    ${dots}
  `;
}

// Mobile: update the active dot as the user swipes between pages.
function _wirePreviewSwipe() {
  const pages = document.querySelector('#preview-content .preview-pages');
  const dots = document.querySelectorAll('#preview-content .preview-dots .dot');
  if (!pages || dots.length < 2) return;
  pages.addEventListener('scroll', () => {
    const w = pages.clientWidth;
    if (!w) return;
    const i = Math.round(pages.scrollLeft / w);
    dots.forEach((d, j) => d.classList.toggle('on', j === i));
  }, { passive: true });
}

// ---- Map interaction -----------------------------------------------------

let isDrawing = false;
map.on(L.Draw.Event.DRAWSTART, () => { isDrawing = true; });
// Leaflet.draw fires DRAWSTOP slightly before the closing click bubbles up to
// the map; delay clearing the flag so map.click sees us as "still drawing".
map.on(L.Draw.Event.DRAWSTOP, () => { setTimeout(() => { isDrawing = false; }, 150); });

// Persist view + settings across reloads (URL hash).
map.on('moveend', saveState);

// Any setting change writes to the URL.
const _persistedSettingIds = new Set([
  'lock-to-track', 'zoom-to-fit-matches', 'heatmap-toggle',
  'base-layer', 'base-opacity', 'search-radius', 'dim-opacity',
]);

// Live update of the aggregate dim style + label as the user drags the slider.
const _dimOpacityInput = document.getElementById('dim-opacity');
if (_dimOpacityInput) {
  _dimOpacityInput.addEventListener('input', () => {
    const lbl = document.getElementById('dim-opacity-label');
    if (lbl) lbl.textContent = _dimOpacityInput.value;
    if (lastMatches && lastMatches.length && activeAggLod
        && aggregateLayers[activeAggLod] && map.hasLayer(aggregateLayers[activeAggLod])) {
      aggregateLayers[activeAggLod].setStyle(_styleAggDim());
    }
  });
}
document.addEventListener('change', e => {
  if (e.target && _persistedSettingIds.has(e.target.id)) saveState();
});
// Sliders also fire `input` continuously — debounce-save them.
let _settingSaveTimer = null;
document.addEventListener('input', e => {
  if (!e.target || !_persistedSettingIds.has(e.target.id)) return;
  clearTimeout(_settingSaveTimer);
  _settingSaveTimer = setTimeout(saveState, 300);
});

// ---- Auto-match: when only one track is in view, treat as a match -------

let autoMatchTimer = null;

function _bboxIntersectsView(bbox, view) {
  // bbox = [minlon, minlat, maxlon, maxlat]
  if (bbox[2] < view.getWest() || bbox[0] > view.getEast()) return false;
  if (bbox[3] < view.getSouth() || bbox[1] > view.getNorth()) return false;
  return true;
}

async function maybeAutoMatch() {
  if (map.getZoom() < HEX_ZOOM_THRESHOLD) return;
  if (autoMatchSuppressed) return;
  if (clickMarker && autoMatchedId == null) return;
  if (!indexById.size) return;

  const view = map.getBounds();
  let only = null;
  let count = 0;
  for (const [id, a] of indexById) {
    if (_bboxIntersectsView(a.bbox, view)) {
      count++;
      if (count > 1) break;
      only = id;
    }
  }

  if (count === 1 && only != null) {
    if (autoMatchedId === only) return;
    autoMatchedId = only;
    const a = indexById.get(only);
    const anchor = L.latLng(a.samples[Math.floor(a.samples.length / 2)]);
    // Auto-match goes via /match so we get the precise geometry to render.
    try {
      const p = new URLSearchParams({ lat: anchor.lat, lon: anchor.lng, r: currentRadiusMetres() });
      for (const [k, v] of new URLSearchParams(filterQueryString())) p.set(k, v);
      const r = await fetch(`/match?${p.toString()}`);
      const matches = await r.json();
      const hit = matches.find(m => m.id === only) || matches[0];
      if (!hit) { autoMatchedId = null; return; }
      clearClickGraphics();
      clickMarker = L.circleMarker(anchor, {
        radius: 6, color: '#d62728', fillOpacity: 0.9, weight: 2,
      }).addTo(map);
      renderMatches([hit], anchor, { fit: false });
    } catch {
      autoMatchedId = null;
    }
  } else if (autoMatchedId != null) {
    autoMatchedId = null;
    clearClickGraphics();
    clearMatches();
  }
}

map.on('moveend', () => {
  clearTimeout(autoMatchTimer);
  autoMatchTimer = setTimeout(maybeAutoMatch, 250);
});

function clearClickGraphics() {
  if (clickMarker) { map.removeLayer(clickMarker); clickMarker = null; }
  if (clickRadiusCircle) { map.removeLayer(clickRadiusCircle); clickRadiusCircle = null; }
}

function drawClickGraphics(target, radiusM) {
  clearClickGraphics();
  clickRadiusCircle = L.circle(target, {
    radius: radiusM,
    color: '#0891b2', weight: 1.5, opacity: 0.85,
    fillColor: '#0891b2', fillOpacity: 0.08,
  }).addTo(map);
  const pinHtml = `<svg viewBox="0 0 24 32" width="22" height="29" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 20 12 20s12-11 12-20c0-6.6-5.4-12-12-12z" fill="#0891b2" stroke="#fff" stroke-width="2"/>
    <circle cx="12" cy="12" r="4" fill="#fff"/>
  </svg>`;
  clickMarker = L.marker(target, {
    icon: L.divIcon({ html: pinHtml, className: 'click-pin', iconSize: [22, 29], iconAnchor: [11, 29] }),
    interactive: false, keyboard: false, zIndexOffset: 800,
  }).addTo(map);
}

// Esc clears the current selection: drops any drawn rect/poly + active
// matches + click graphics. Skipped if focus is in a text input or a popover
// has its own dismiss handling.
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  let acted = false;
  if (polygonFilter || polygonBounds) { clearPolygonFilter(); acted = true; }
  if (lastMatches && lastMatches.length) { clearMatches(); acted = true; }
  if (clickMarker || clickRadiusCircle) { clearClickGraphics(); acted = true; }
  if (acted) {
    e.preventDefault();
    saveState();
  }
});

map.on('click', e => {
  if (isDrawing) return;
  // In hex (low-zoom) mode the hex feature's own click already handles drill-in;
  // ignore stray map clicks.
  if (map.getZoom() < HEX_ZOOM_THRESHOLD) return;
  if (e.originalEvent.target && e.originalEvent.target.closest('.leaflet-control')) return;
  if (e.originalEvent.target && e.originalEvent.target.closest('.leaflet-draw-toolbar')) return;

  // An explicit user click counts as "engagement" — un-suppress auto-match.
  autoMatchSuppressed = false;

  // A click-to-select supersedes any active rect/poly bounding-box filter —
  // drop the shape so the user isn't left with stale highlight context.
  if (polygonFilter || polygonBounds) clearPolygonFilter();

  let target = e.latlng;
  if (document.getElementById('lock-to-track').checked) {
    const snapped = snapToNearestTrack(e.latlng);
    if (snapped) target = snapped;
  }

  _filteredMatchActive = false;     // location click supersedes filter-match mode
  drawClickGraphics(target, currentRadiusMetres());
  queryPoint(target.lat, target.lng);
  // No flyTo here — renderMatches will fit-bounds to the matched tracks.
});

// NOTE: don't resize clickRadiusCircle on zoom — it represents the actual
// search radius (in metres) that produced the current matches. The L.circle
// scales correctly visually as the user zooms; changing its `radius` would
// imply a different search than what was performed.

map.on(L.Draw.Event.CREATED, async e => {
  pushHistoryCheckpoint();
  drawnItems.clearLayers();
  drawnItems.addLayer(e.layer);
  e.layer.setStyle({ color: '#d62728', weight: 2, fill: false });
  clearClickGraphics();
  hideMatchesPanel();

  const latlngs = e.layer.getLatLngs()[0];
  const pts = latlngs.map(p => `${p.lng} ${p.lat}`);
  pts.push(`${latlngs[0].lng} ${latlngs[0].lat}`);
  polygonFilter = `POLYGON((${pts.join(', ')}))`;
  polygonBounds = e.layer.getBounds();
  autoMatchSuppressed = false;
  showPolygonCloseBtn();

  // Polygon highlights matches but doesn't hide other tracks — fetch the
  // intersecting set as a match, leave the loaded geojson untouched.
  showSpinner();
  let matches = [];
  try { matches = await fetchPolygonMatches(); } finally { hideSpinner(); }
  if (matches.length) {
    renderMatches(matches, polygonBounds.getCenter());
  }
  map.flyToBounds(polygonBounds, { padding: [40, 40], maxZoom: 17, duration: 0.6 });
  saveState();
});

// ---- Import + Strava UI --------------------------------------------------

document.getElementById('zip-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  const status = document.getElementById('zip-status');
  status.className = 'status';
  status.textContent = `Uploading ${(file.size / 1e6).toFixed(1)} MB…`;
  showSpinner('Uploading export…');

  const fd = new FormData();
  fd.append('file', file);
  let r;
  try {
    r = await fetch('/import/zip', { method: 'POST', body: fd });
    if (!r.ok) throw new Error(await r.text());
  } catch (err) {
    hideSpinner();
    status.className = 'status error';
    status.textContent = `Upload failed: ${err.message || err}`;
    return;
  }
  // Server now processing in the background — poll for status.
  pollImportStatus(status);
});

async function pollImportStatus(statusEl) {
  let timer;
  const tick = async () => {
    let j;
    try { j = await (await fetch('/import/zip/status')).json(); }
    catch { return; }

    if (j.phase === 'uploading' || j.phase === 'unzipping') {
      statusEl.className = 'status';
      statusEl.textContent = j.message || 'Preparing import…';
      updateSpinner(j.message || 'Preparing import…');
    } else if (j.phase === 'importing') {
      const pct = j.total ? Math.round((j.processed / j.total) * 100) : 0;
      const text = `${j.processed}/${j.total} parsed (${pct}%) · ${j.inserted} runs imported`;
      statusEl.className = 'status';
      statusEl.textContent = text;
      updateSpinner(text);
    } else if (j.phase === 'done') {
      clearInterval(timer);
      hideSpinner();
      statusEl.className = 'status ok';
      statusEl.textContent = j.message;
      await loadData();
      await loadAllActivities();
      flyToLastRun();
      applyZoomMode();
      await loadStats();
    } else if (j.phase === 'error') {
      clearInterval(timer);
      hideSpinner();
      statusEl.className = 'status error';
      statusEl.textContent = j.message || j.error || 'Import failed';
    }
  };
  await tick();
  timer = setInterval(tick, 1000);
}

document.getElementById('save-creds').onclick = async () => {
  const fd = new FormData();
  fd.append('client_id', document.getElementById('cid').value);
  fd.append('client_secret', document.getElementById('csec').value);
  const r = await fetch('/strava/config', { method: 'POST', body: fd });
  if (r.ok) refreshStravaUI();
};

document.getElementById('test-creds').onclick = async () => {
  const s = document.getElementById('test-status');
  s.className = 'status'; s.textContent = 'Testing…';
  const r = await fetch('/strava/test');
  if (r.ok) {
    const j = await r.json();
    s.className = 'status ok';
    s.textContent = `Connected as ${j.firstname} ${j.lastname}`.trim();
  } else {
    s.className = 'status error'; s.textContent = 'Test failed';
  }
};

document.getElementById('forget-tokens').onclick = async () => {
  await fetch('/strava/tokens', { method: 'DELETE' });
  refreshStravaUI();
};

async function refreshStravaUI() {
  const r = await fetch('/strava/status');
  const s = await r.json();

  document.getElementById('cid').value = s.client_id || '';
  document.getElementById('test-creds').hidden = !s.has_tokens;
  document.getElementById('forget-tokens').hidden = !s.has_tokens;

  const authDiv = document.getElementById('strava-auth');
  const syncDiv = document.getElementById('strava-sync');
  const credsDetails = document.getElementById('creds-details');

  // Auto-open the credentials block when there are none yet, collapse it when set up.
  credsDetails.open = !s.has_creds;

  if (!s.has_creds) {
    authDiv.innerHTML = '';
    syncDiv.innerHTML = '';
    return;
  }

  if (!s.has_tokens) {
    syncDiv.innerHTML = '';
    authDiv.innerHTML = `
      <p><a id="auth-link" target="_blank" rel="noopener">Open Strava authorisation page</a> → paste the <code>code</code> query param from the redirect URL:</p>
      <input id="oauth-code" placeholder="paste code here">
      <button id="do-exchange">Authorise</button>
      <div id="oauth-status" class="status"></div>
    `;
    const u = await (await fetch('/strava/authorize_url')).json();
    document.getElementById('auth-link').href = u.url;
    document.getElementById('do-exchange').onclick = async () => {
      const fd = new FormData();
      fd.append('code', document.getElementById('oauth-code').value);
      const stat = document.getElementById('oauth-status');
      const r = await fetch('/strava/exchange', { method: 'POST', body: fd });
      if (r.ok) refreshStravaUI();
      else { stat.className = 'status error'; stat.textContent = 'OAuth failed — re-check your code'; }
    };
    return;
  }

  authDiv.innerHTML = '';
  syncDiv.innerHTML = `
    <label for="sync-range">Sync range</label>
    <select id="sync-range">
      <option>Since last sync</option>
      <option>Last 30 days</option>
      <option>Last 12 months</option>
      <option>From the beginning</option>
    </select>
    <button id="do-sync">Sync now</button>
    <div id="sync-status" class="status"></div>
  `;
  document.getElementById('do-sync').onclick = async () => {
    const s = document.getElementById('sync-status');
    s.className = 'status'; s.textContent = 'Starting…';
    const fd = new FormData();
    fd.append('range', document.getElementById('sync-range').value);
    const r = await fetch('/strava/sync', { method: 'POST', body: fd });
    if (!r.ok) {
      s.className = 'status error';
      s.textContent = `Sync failed: ${await r.text()}`;
      return;
    }
    pollSyncStatus(s);
  };
};

async function pollSyncStatus(statusEl) {
  let pollTimer;
  const tick = async () => {
    let j;
    try { j = await (await fetch('/strava/sync/status')).json(); }
    catch { /* transient — retry */ return; }

    if (j.phase === 'rate_limited') {
      statusEl.className = 'status'; statusEl.textContent = j.message;
    } else if (j.phase === 'listing') {
      statusEl.className = 'status'; statusEl.textContent = j.message || 'Listing activities…';
    } else if (j.phase === 'processing') {
      const pct = j.total ? Math.round((j.processed / j.total) * 100) : 0;
      statusEl.className = 'status';
      statusEl.textContent = `${j.processed}/${j.total} processed (${pct}%) · ${j.inserted} runs imported so far`;
    } else if (j.phase === 'done') {
      clearInterval(pollTimer);
      statusEl.className = 'status ok';
      statusEl.textContent = j.message;
      await loadData();
      await loadAllActivities();
      flyToLastRun();
      applyZoomMode();
      await loadStats();
    } else if (j.phase === 'error') {
      clearInterval(pollTimer);
      statusEl.className = 'status error';
      statusEl.textContent = j.message || j.error || 'Sync failed';
    }
  };
  // Run once immediately, then every second.
  await tick();
  pollTimer = setInterval(tick, 1000);
}

// ---- Settings drawer + matches panel chrome ------------------------------

function openSettings() {
  document.getElementById('settings-drawer').classList.remove('hidden');
  document.getElementById('scrim').classList.remove('hidden');
}
function closeSettings() {
  document.getElementById('settings-drawer').classList.add('hidden');
  document.getElementById('scrim').classList.add('hidden');
}
document.getElementById('open-settings').onclick = async () => { openSettings(); await loadStats(); };
document.getElementById('close-settings').onclick = closeSettings;
document.getElementById('scrim').onclick = closeSettings;

// User-initiated × on the matches panel: suppress further auto-matches.
// If the matches came from a drawn polygon, dismissing them dismisses the
// polygon too — otherwise the outline strands on the map looking like an
// active filter (and its own × can sit buried under this very panel).
document.getElementById('matches-close').onclick = () => {
  autoMatchSuppressed = true;
  autoMatchedId = null;
  if (polygonFilter || polygonBounds) {
    clearPolygonFilter();
    return;
  }
  clearMatches();
  clearClickGraphics();
};

// Leaving the entire matches panel clears the glow when nothing is pinned.
// Attaches once globally and uses the closure exposed by renderMatches.
document.getElementById('matches-panel').addEventListener('mouseleave', () => {
  if (previewActivityId == null && currentEmphasise) currentEmphasise(null);
});

// Base map controls
document.getElementById('base-layer').addEventListener('change', e => setBaseLayer(e.target.value));

// Thunderforest API key — stored in localStorage (not the URL hash, since it's a secret).
function _tfStatus(msg, ok) {
  const el = document.getElementById('tf-apikey-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'status ' + (ok ? 'ok' : (msg ? 'error' : ''));
}
(function _initTFInput() {
  const input = document.getElementById('tf-apikey');
  if (!input) return;
  input.value = _tfKey();
  document.getElementById('tf-apikey-save').addEventListener('click', () => {
    const v = input.value.trim();
    if (!v) { _tfStatus('Empty key — nothing saved.', false); return; }
    localStorage.setItem(TF_KEY_STORAGE, v);
    rebuildTFLayers();
    // Default to Thunderforest Landscape once a key is in place.
    const sel = document.getElementById('base-layer');
    if (sel) {
      sel.value = 'Thunderforest Landscape';
      setBaseLayer('Thunderforest Landscape');
      saveState();
    }
    _tfStatus('Saved. Thunderforest Landscape is now active.', true);
  });
  document.getElementById('tf-apikey-clear').addEventListener('click', () => {
    localStorage.removeItem(TF_KEY_STORAGE);
    input.value = '';
    // If we were on a TF layer, fall back to the default.
    if (_isTFName(_activeBaseLayerName())) {
      const sel = document.getElementById('base-layer');
      if (sel) {
        sel.value = 'Topo (OpenTopoMap)';
        setBaseLayer('Topo (OpenTopoMap)');
      }
    }
    rebuildTFLayers();
    _tfStatus('Cleared.', true);
  });
})();
document.getElementById('base-opacity').addEventListener('input', e => {
  document.getElementById('opacity-label').textContent = e.target.value;
  setBaseOpacity(parseInt(e.target.value, 10));
});

document.getElementById('search-radius').addEventListener('input', e => {
  const v = parseInt(e.target.value, 10);
  document.getElementById('search-radius-label').textContent = v > 0 ? `${v} m` : 'auto';
  if (clickRadiusCircle) clickRadiusCircle.setRadius(currentRadiusMetres());
});

document.getElementById('apply-radius').onclick = () => {
  if (!clickMarker) return;
  const p = clickMarker.getLatLng();
  queryPoint(p.lat, p.lng);
};

// Hike/walk minimum-distance setting: empty input = server default.
function _setHikeMin(v) {
  hikeMinKm = v;
  applyFilters();
  loadStats();
}
document.getElementById('hike-min-km').addEventListener('change', e => {
  const raw = e.target.value.trim();
  const v = raw === '' ? null : Math.max(Number(raw), 0);
  if (v != null && !Number.isFinite(v)) return;
  _setHikeMin(v);
});
document.getElementById('hike-min-reset').onclick = () => {
  document.getElementById('hike-min-km').value = '';
  _setHikeMin(null);
};


// Heatmap overlay toggle — separate density layer (proper kernel) on top of
// the aggregate. Visible only at z >= HEX_ZOOM_THRESHOLD.
document.getElementById('heatmap-toggle')?.addEventListener('change', () => {
  applyHeatmapVisibility();
  saveState();
});

// ---- Filter chip bar ----------------------------------------------------

let _filterOptions = { min_date: null, max_date: null, types: [] };
let _datePicker = null;  // flatpickr instance, created lazily on first menu open

async function loadFilterOptions() {
  try {
    _filterOptions = await (await fetch('/filter-options')).json();
  } catch { /* leave defaults */ }
}

// Unfiltered slice of /index.json used for live filter-menu previews. Fetched
// once at boot; the rest of the app reads from the filter-aware `indexById`,
// which can shrink as filters apply. Keeping the unfiltered set in a separate
// flat array lets the open filter menu re-bin the histogram against the
// *current draft* of the other facets (date / type) without round-tripping
// the server.
let _allActivities = [];

async function loadAllActivities() {
  try {
    const r = await fetch('/index.json');  // no filters
    const j = await r.json();
    _allActivities = (j.activities || []).map(a => ({
      id: a.id,
      start_time: a.start_time,
      type: a.type,
      distance_m: a.distance_m,
      gear: a.gear ?? null,
    }));
  } catch { /* leave empty */ }
}

// Read the unapplied state of the filter widgets so the histogram can react
// before the user hits Apply. Distance bounds themselves are excluded — a
// facet's histogram represents its own dimension, so the bars shouldn't move
// as the user drags the distance handles.
function _draftOtherFilters() {
  const fp = _datePicker;
  let date_start = null, date_end = null;
  if (fp && fp.selectedDates && fp.selectedDates.length === 2) {
    const ymd = d => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };
    date_start = ymd(fp.selectedDates[0]);
    date_end   = ymd(fp.selectedDates[1]);
  }
  // Type is now driven by the always-visible type pills — they write
  // straight into activeFilters.type, so the draft view just reads from there.
  const gearHost = document.getElementById('filter-gear-list');
  let gear = activeFilters.gear;
  if (gearHost && gearHost.dataset.built) {
    const checked = [...gearHost.querySelectorAll('input:checked')].map(el => el.dataset.gear);
    gear = checked.length ? checked : null;
  }
  return { date_start, date_end, type: activeFilters.type, gear };
}

function _activityMatchesOtherFilters(a, f) {
  if (f.type && !f.type.split(',').includes(a.type)) return false;
  if (f.gear && f.gear.length) {
    if (!f.gear.includes(a.gear || '')) return false;
  }
  if (f.date_start || f.date_end) {
    if (!a.start_time) return false;
    const d = a.start_time.slice(0, 10);
    if (f.date_start && d < f.date_start) return false;
    if (f.date_end && d > f.date_end) return false;
  }
  return true;
}

function _fmtDateChip() {
  const a = activeFilters.date_start;
  const b = activeFilters.date_end;
  if (a && b) return `${a} → ${b}`;
  if (a) return `since ${a}`;
  if (b) return `until ${b}`;
  return '';
}

function renderFilterChips() {
  const host = document.getElementById('filter-chips');
  const chips = [];
  const dateLabel = _fmtDateChip();
  if (dateLabel) chips.push({ key: 'date', label: dateLabel });
  // Type is now carried by the always-visible type pills — no chip.
  if (activeFilters.min_km != null || activeFilters.max_km != null) {
    const lo = activeFilters.min_km != null ? `≥${activeFilters.min_km}` : '';
    const hi = activeFilters.max_km != null ? `<${activeFilters.max_km}` : '';
    const sep = lo && hi ? ' & ' : '';
    chips.push({ key: 'dist', label: `${lo}${sep}${hi} km` });
  }
  for (const g of activeFilters.gear || []) {
    chips.push({ key: `gear:${g}`, label: `👟 ${g || '(no shoe)'}` });
  }
  host.innerHTML = chips.map(c =>
    `<span class="chip" data-key="${c.key}">${escapeHTML(c.label)}<span class="x" title="Remove">×</span></span>`
  ).join('');
  for (const el of host.querySelectorAll('.chip .x')) {
    el.addEventListener('click', () => {
      const key = el.parentElement.dataset.key;
      if (key === 'date') { activeFilters.date_start = null; activeFilters.date_end = null; }
      if (key === 'dist') { activeFilters.min_km = null; activeFilters.max_km = null; }
      if (key.startsWith('gear:')) {
        const g = key.slice(5);
        const next = (activeFilters.gear || []).filter(x => x !== g);
        activeFilters.gear = next.length ? next : null;
      }
      applyFilters();
    });
  }
}

// Preset shortcuts that drive the flatpickr range. `null` for an endpoint
// means "use the library bound" (i.e. all-time on that side).
function _datePresets() {
  const today = new Date();
  const ymd = d => d.toISOString().slice(0, 10);
  const back = days => {
    const d = new Date(today);
    d.setDate(d.getDate() - days);
    return d;
  };
  return [
    { label: 'Last month',     from: () => [back(30),  today] },
    { label: 'Last 6 months',  from: () => [back(182), today] },
    { label: 'Last 12 months', from: () => [back(365), today] },
  ];
}

function _ensureDatePicker() {
  if (_datePicker) return _datePicker;
  const input = document.getElementById('filter-date-range');
  if (!input || !window.flatpickr) return null;
  const cfg = {
    mode: 'range',
    dateFormat: 'Y-m-d',
    allowInput: false,
    showMonths: 1,
  };
  if (_filterOptions.min_date) cfg.minDate = _filterOptions.min_date;
  if (_filterOptions.max_date) cfg.maxDate = _filterOptions.max_date;
  // Cascade: when the date range changes inside the menu, re-bin the
  // distance histogram against the new draft date window. Only fire once
  // the range is fully picked (or fully cleared) to avoid flicker mid-drag.
  cfg.onChange = (selectedDates) => {
    if (selectedDates.length === 0 || selectedDates.length === 2) {
      _renderDistanceHistogram();
      _syncShowMatchesEnabled();
    }
  };
  _datePicker = flatpickr(input, cfg);

  // Preset buttons sit above the input — clicking sets the picker.
  const host = document.getElementById('filter-date-presets');
  if (host && !host.dataset.wired) {
    host.dataset.wired = '1';
    host.innerHTML = _datePresets().map((p, i) =>
      `<button type="button" class="date-preset" data-i="${i}">${p.label}</button>`
    ).join('');
    host.addEventListener('click', e => {
      const btn = e.target.closest('button.date-preset');
      if (!btn) return;
      const preset = _datePresets()[Number(btn.dataset.i)];
      const [from, to] = preset.from();
      if (from && to) {
        // Clamp both ends to the picker's allowed range. Without this, a
        // preset like "Last 7 days" with `to = today` is rejected by
        // flatpickr when today is past the library's max activity date —
        // only `from` lands, and Apply sees a single-day selection.
        const clamp = d => {
          if (!d) return d;
          let out = d;
          if (_filterOptions.min_date) {
            const lo = new Date(_filterOptions.min_date + 'T00:00:00');
            if (out < lo) out = lo;
          }
          if (_filterOptions.max_date) {
            const hi = new Date(_filterOptions.max_date + 'T00:00:00');
            if (out > hi) out = hi;
          }
          return out;
        };
        _datePicker.setDate([clamp(from), clamp(to)], true);
      } else {
        _datePicker.clear();
      }
    });
  }
  return _datePicker;
}

// Distance widget state. The slider operates on a fixed [0, distMaxKm] range;
// the histogram is recomputed from indexById on each open so it stays in sync
// with whatever activities the rest of the filter set has loaded.
let _distMaxKm = 100;
// Sorted unique distances (km, rounded) present in the cascade-filtered set,
// always including 0 and _distMaxKm so both ends remain reachable. The slider
// thumbs snap onto these on every `input`, so every notch corresponds to at
// least one real run instead of leaving dead 1-km positions in sparse regions.
let _distSnapValues = [0, 100];
let _distWiredHandlers = false;

function _activityDistancesKm() {
  // Use the unfiltered set, then narrow by the *draft* of the other facets
  // (date + type) so the histogram cascades as the user edits inside the
  // menu — without waiting for them to hit Apply.
  const src = _allActivities.length ? _allActivities : Array.from(indexById.values());
  const f = _draftOtherFilters();
  const out = [];
  for (const a of src) {
    if (!Number.isFinite(a.distance_m)) continue;
    if (!_activityMatchesOtherFilters(a, f)) continue;
    out.push(a.distance_m / 1000);
  }
  return out;
}

// Shoes facet: checkbox per distinct gear value, counts cascaded by the
// *other* draft facets (date + type) — a facet never narrows itself.
function _renderGearList() {
  const host = document.getElementById('filter-gear-list');
  if (!host) return;
  const f = { ..._draftOtherFilters(), gear: null };
  const src = _allActivities.length ? _allActivities : Array.from(indexById.values());
  const counts = new Map();
  for (const a of src) {
    if (!_activityMatchesOtherFilters(a, f)) continue;
    const g = a.gear || '';
    counts.set(g, (counts.get(g) || 0) + 1);
  }
  const selected = new Set(activeFilters.gear || []);
  const rows = [...counts.entries()]
    .sort((x, y) => (x[0] === '') - (y[0] === '') || y[1] - x[1]);  // "(no shoe)" last
  host.innerHTML = rows.map(([g, n]) => `
    <label><input type="checkbox" data-gear="${escapeHTML(g)}" ${selected.has(g) ? 'checked' : ''}>
      <span>${g ? escapeHTML(g) : '(no shoe)'}</span><span class="gear-count">${n}</span></label>
  `).join('');
  host.dataset.built = '1';
}

(function _wireGearList() {
  const host = document.getElementById('filter-gear-list');
  if (!host) return;
  // Re-bin the distance histogram when the shoe draft changes (cascade).
  host.addEventListener('change', () => { _renderDistanceHistogram(); _syncShowMatchesEnabled(); });
  document.getElementById('filter-gear-clear')?.addEventListener('click', () => {
    for (const el of host.querySelectorAll('input:checked')) el.checked = false;
    _renderDistanceHistogram();
    _syncShowMatchesEnabled();
  });
})();

function _renderDistanceHistogram() {
  const svg = document.getElementById('filter-dist-hist');
  const dists = _activityDistancesKm();
  if (!svg) return;
  // Cap at the actual longest run (rounded up to the next whole km). Snapping
  // to a "nice" round number leaves the upper-handle tail empty; tight bound
  // means the rightmost bars are populated and the slider tracks the real
  // distribution.
  const maxObserved = dists.length ? Math.max(...dists) : 10;
  _distMaxKm = Math.max(1, Math.ceil(maxObserved));

  const snapSet = new Set([0, _distMaxKm]);
  for (const d of dists) snapSet.add(Math.round(d));
  _distSnapValues = Array.from(snapSet).sort((a, b) => a - b);

  const minR = document.getElementById('filter-dist-min');
  const maxR = document.getElementById('filter-dist-max');
  const prevMax = Number(maxR.max) || _distMaxKm;
  minR.max = String(_distMaxKm);
  maxR.max = String(_distMaxKm);
  // If the cap shrank under the current handles (e.g. user picked a narrow
  // date range and only short runs survive), pull the handles in. If the
  // upper handle was at the previous cap, keep it at the new cap so the
  // visual "open-ended" semantics survive.
  let lo = Number(minR.value), hi = Number(maxR.value);
  if (hi > _distMaxKm || hi === prevMax) hi = _distMaxKm;
  if (lo > _distMaxKm) lo = _distMaxKm;
  if (lo > hi) lo = hi;
  minR.value = String(lo);
  maxR.value = String(hi);

  // Bin counts: one bar per integer km up to _distMaxKm, clipped to a max
  // bar count of 50 so very long-distance libraries still get a sensible
  // bar width.
  const bins = Math.min(_distMaxKm, 50);
  const binW = _distMaxKm / bins;
  const counts = new Array(bins).fill(0);
  for (const d of dists) {
    const i = Math.min(bins - 1, Math.max(0, Math.floor(d / binW)));
    counts[i] += 1;
  }
  const peak = Math.max(1, ...counts);

  // viewBox lets the SVG stretch to its CSS width without us touching the
  // DOM on resize. Bars are width-1 in a `bins`-wide space; height scales
  // counts/peak across a height of 100.
  svg.setAttribute('viewBox', `0 0 ${bins} 100`);
  const bars = counts.map((c, i) => {
    const h = c / peak * 100;
    return `<rect x="${i}" y="${100 - h}" width="1" height="${h}" fill="#1a5a8a" fill-opacity="0.35"/>`;
  }).join('');
  svg.innerHTML = bars;
  _updateDistTrack();
}

function _snapDist(v) {
  const arr = _distSnapValues;
  if (!arr.length) return v;
  let best = arr[0], bestD = Math.abs(v - best);
  for (let i = 1; i < arr.length; i++) {
    const d = Math.abs(v - arr[i]);
    if (d < bestD) { best = arr[i]; bestD = d; }
  }
  return best;
}

function _updateDistTrack() {
  const minR = document.getElementById('filter-dist-min');
  const maxR = document.getElementById('filter-dist-max');
  const track = document.getElementById('filter-dist-track');
  const readout = document.getElementById('filter-dist-readout');
  if (!minR || !maxR || !track) return;
  let lo = _snapDist(Number(minR.value));
  let hi = _snapDist(Number(maxR.value));
  minR.value = String(lo);
  maxR.value = String(hi);
  if (lo > hi) {
    // Snap the handle the user is dragging: which one is furthest from a
    // valid position?
    if (document.activeElement === minR) { hi = lo; maxR.value = String(hi); }
    else { lo = hi; minR.value = String(lo); }
  }
  const pct = v => (v / _distMaxKm) * 100;
  track.style.left  = `${pct(lo)}%`;
  track.style.right = `${100 - pct(hi)}%`;
  readout.textContent = `${lo} km – ${hi} km`;
}

function _setDistRange(loKm, hiKm) {
  const minR = document.getElementById('filter-dist-min');
  const maxR = document.getElementById('filter-dist-max');
  // Clamp to widget range so handles never sit off-track.
  const lo = Math.max(0, Math.min(_distMaxKm, loKm ?? 0));
  const hi = Math.max(0, Math.min(_distMaxKm, hiKm ?? _distMaxKm));
  minR.value = String(lo);
  maxR.value = String(hi);
  _updateDistTrack();
}

function _wireDistanceHandlers() {
  if (_distWiredHandlers) return;
  _distWiredHandlers = true;
  for (const id of ['filter-dist-min', 'filter-dist-max']) {
    document.getElementById(id).addEventListener('input', _updateDistTrack);
  }
}

function populateFilterMenu() {
  const fp = _ensureDatePicker();
  if (fp) {
    if (activeFilters.date_start && activeFilters.date_end) {
      fp.setDate([activeFilters.date_start, activeFilters.date_end], false);
    } else if (activeFilters.date_start) {
      fp.setDate([activeFilters.date_start], false);
    } else {
      fp.clear();
    }
  }
  // Distance: refresh histogram against current indexById, then position handles.
  _renderGearList();
  _renderDistanceHistogram();
  _wireDistanceHandlers();
  _setDistRange(activeFilters.min_km, activeFilters.max_km);
  _syncShowMatchesEnabled();
}

function toggleFilterMenu(anchorEl) {
  const menu = document.getElementById('filter-menu');
  const isMobile = window.matchMedia('(max-width: 700px)').matches;
  if (isMobile) {
    menu.style.top = '';
    menu.style.left = '';
  } else if (anchorEl) {
    const rect = anchorEl.getBoundingClientRect();
    menu.style.top = `${rect.top}px`;
    // Anchor to the right of the left toolbar (or button) so the popover
    // sits beside the control rather than overlapping it.
    menu.style.left = `${rect.right + 8}px`;
  }
  populateFilterMenu();
  for (const id of ['display-menu']) document.getElementById(id).classList.add('hidden');
  menu.classList.toggle('hidden');
  document.body.classList.toggle('filter-menu-open', !menu.classList.contains('hidden'));
}

// Read the draft pane state (date/type/distance) into `activeFilters`.
// Shared by Apply and Show-as-matches so both buttons emit the same filter set.
function _readFilterDraft() {
  const ymd = d => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const sel = _datePicker?.selectedDates || [];
  if (sel.length === 2) {
    activeFilters.date_start = ymd(sel[0]);
    activeFilters.date_end   = ymd(sel[1]);
  } else if (sel.length === 1) {
    activeFilters.date_start = ymd(sel[0]);
    activeFilters.date_end   = ymd(sel[0]);
  } else {
    activeFilters.date_start = null;
    activeFilters.date_end   = null;
  }
  // Type is owned by the always-visible type pills — they write
  // activeFilters.type directly, so nothing to read here.

  const lo = Number(document.getElementById('filter-dist-min').value);
  const hi = Number(document.getElementById('filter-dist-max').value);
  activeFilters.min_km = lo > 0 ? lo : null;
  activeFilters.max_km = hi < _distMaxKm ? hi : null;

  const gearHost = document.getElementById('filter-gear-list');
  const checked = gearHost
    ? [...gearHost.querySelectorAll('input:checked')].map(el => el.dataset.gear)
    : [];
  activeFilters.gear = checked.length ? checked : null;
}

function _closeFilterMenu() {
  document.getElementById('filter-menu').classList.add('hidden');
  document.body.classList.remove('filter-menu-open');
}

document.getElementById('filter-apply').addEventListener('click', () => {
  _readFilterDraft();
  _closeFilterMenu();
  applyFilters();
});

// Marks "Show matches in view" mode so subsequent filter changes (notably
// the always-visible type pills) can re-run the match query instead of
// reverting to no matches. Cleared on clearMatches / location click / draw.
let _filteredMatchActive = false;

async function fetchFilteredMatches() {
  if (!hasActiveFilters()) return [];
  // Bound to the current viewport — matches the mental model of every other
  // interaction on this map and keeps the response size in check.
  const b = map.getBounds();
  const s = b.getSouth(), n = b.getNorth(), w = b.getWest(), e = b.getEast();
  const wkt = `POLYGON((${w} ${s}, ${e} ${s}, ${e} ${n}, ${w} ${n}, ${w} ${s}))`;
  const fd = new FormData();
  fd.append('wkt', wkt);
  for (const [k, v] of new URLSearchParams(filterQueryString())) fd.append(k, v);
  const r = await fetch('/match/polygon', { method: 'POST', body: fd });
  return r.ok ? r.json() : [];
}

document.getElementById('filter-show-matches').addEventListener('click', async () => {
  _readFilterDraft();
  if (!hasActiveFilters()) return;
  _closeFilterMenu();
  // Heatmap is exploratory and visually fights with the red match polylines.
  // Suppress it up-front so it goes away immediately rather than after the
  // (potentially seconds-long) /match/filter response lands.
  heatmapClickSuppressed = true;
  applyHeatmapVisibility();
  _syncHeatmapToggleEnabled();
  await applyFilters();
  showSpinner('Matching…');
  let matches = [];
  try { matches = await fetchFilteredMatches(); } finally { hideSpinner(); }
  if (!matches.length) {
    _filteredMatchActive = false;
    showToast('No tracks match these filters.');
    return;
  }
  _filteredMatchActive = true;
  renderMatches(matches, null, { fit: false });
  // "Show as matches" is explicitly "take me to these" — fit-bounds, but
  // only if the resulting view would stay in track-zoom mode. A very wide
  // filter (e.g. "all >40 km runs" across the UK) would otherwise zoom out
  // below HEX_ZOOM_THRESHOLD, which triggers applyZoomMode → clearMatchLayers
  // and wipes the polylines we just drew.
  let b = null;
  for (const m of matches) {
    const layer = matchLayersById.get(m.id);
    if (!layer) continue;
    const lb = layer.getBounds();
    b = b ? b.extend(lb) : L.latLngBounds(lb.getSouthWest(), lb.getNorthEast());
  }
  if (b) {
    const targetZoom = map.getBoundsZoom(b, false, [20, 20]);
    if (targetZoom >= HEX_ZOOM_THRESHOLD) {
      map.flyToBounds(b, { padding: [20, 20], maxZoom: 17, duration: 0.6 });
    }
  }
});

// Mirror the draft state to the Show-as-matches enabled flag. The pane's
// edit cascade already fires change/input events on these controls; we just
// re-read the draft into activeFilters scratch and check hasActiveFilters().
function _syncShowMatchesEnabled() {
  const btn = document.getElementById('filter-show-matches');
  if (!btn) return;
  // Snapshot live activeFilters, evaluate draft, then restore — we only want
  // the read, not to commit until Apply / Show-as-matches is clicked.
  const snapshot = { ...activeFilters };
  _readFilterDraft();
  const enabled = hasActiveFilters();
  activeFilters = snapshot;
  btn.disabled = !enabled;
}

for (const ev of ['change', 'input']) {
  document.getElementById('filter-menu').addEventListener(ev, _syncShowMatchesEnabled);
}

document.getElementById('filter-date-clear')?.addEventListener('click', () => {
  if (_datePicker) _datePicker.clear();
  _renderDistanceHistogram();
});

document.getElementById('filter-clear').addEventListener('click', () => {
  activeFilters = { date_start: null, date_end: null, type: null, min_km: null, max_km: null, gear: null };
  _allTypesOff = false;
  if (_datePicker) _datePicker.clear();
  for (const el of document.querySelectorAll('#filter-gear-list input:checked')) el.checked = false;
  _setDistRange(0, _distMaxKm);
  _syncTypePills();
  document.getElementById('filter-menu').classList.add('hidden');
  document.body.classList.remove('filter-menu-open');
  applyFilters();
});

// ---- Road / Trail / Hike pills -------------------------------------------
//
// Always-visible pills in the top filter-bar drive `activeFilters.type` directly.
// Semantics: all on = no filter (default); a subset on = comma-list filter of
// those types (canonical ALL_TYPES order, so shared URLs are stable).

// activeFilters.type carries the standard backend filter (comma-list or null).
// "all off" is a client-side-only state: aggregate + matches are hidden and a
// notice surfaces. The backend never sees a request in that state, so the model
// stays in sync with the (i) banner.
let _allTypesOff = false;

function typesFromFilter() {
  return activeFilters.type ? activeFilters.type.split(',') : ALL_TYPES.slice();
}

function setTypeFilter(on) {  // on: Set of type strings, never empty
  activeFilters.type = on.size >= ALL_TYPES.length
    ? null
    : ALL_TYPES.filter(t => on.has(t)).join(',');
}

function _syncTypePills() {
  const notice = document.getElementById('type-empty-notice');
  const on = _allTypesOff ? new Set() : new Set(typesFromFilter());
  for (const pill of document.querySelectorAll('#type-pills .type-pill')) {
    const isOn = on.has(pill.dataset.type);
    pill.classList.toggle('active', isOn);
    pill.setAttribute('aria-pressed', isOn ? 'true' : 'false');
  }
  if (notice) notice.classList.toggle('hidden', !_allTypesOff);
}

function _hideAllTracks() {
  // Aggregate off, hex off, any matches cleared. Heatmap suppressed too.
  _detachAggregate();
  if (hexLayer) { map.removeLayer(hexLayer); hexLayer = null; }
  clearMatches();
  clearClickGraphics();
  if (heatmapLayer && map.hasLayer(heatmapLayer)) map.removeLayer(heatmapLayer);
}

for (const pill of document.querySelectorAll('#type-pills .type-pill')) {
  pill.addEventListener('click', () => {
    const me = pill.dataset.type;
    const on = _allTypesOff ? new Set() : new Set(typesFromFilter());
    if (on.has(me)) on.delete(me); else on.add(me);

    if (on.size === 0) {
      _allTypesOff = true;
      activeFilters.type = null;
      _syncTypePills();
      _hideAllTracks();
      pushHistoryCheckpoint();
      saveState();
      return;
    }
    _allTypesOff = false;
    setTypeFilter(on);
    _syncTypePills();
    if (!document.getElementById('filter-menu').classList.contains('hidden')) {
      _renderDistanceHistogram();
    }
    applyFilters();
  });
}

async function applyFilters() {
  pushHistoryCheckpoint();
  renderFilterChips();
  _syncTypePills();
  // Filters change the data underlying every layer + match. Reload everything.
  invalidateHeatmapData();
  await loadData();
  // Re-run any in-flight matches against the new filter set.
  if (_filteredMatchActive) {
    // Show-matches-in-view mode — re-query against new filters + current view.
    const matches = await fetchFilteredMatches();
    if (matches.length) {
      _filteredMatchActive = true;       // renderMatches doesn't touch the flag
      renderMatches(matches, null, { fit: false });
    } else {
      clearMatches();
    }
  } else if (lastMatches.length && lastClickLatLng) {
    await queryPoint(lastClickLatLng.lat, lastClickLatLng.lng);
  } else if (polygonFilter) {
    const matches = await fetchPolygonMatches();
    if (matches.length) renderMatches(matches, polygonBounds?.getCenter());
    else clearMatches();
  } else {
    clearMatches();
  }
  applyZoomMode();
  saveState();
}

async function loadHeatmapPoints() {
  if (heatmapPoints) return heatmapPoints;
  if (heatmapFetchInFlight) return heatmapFetchInFlight;
  heatmapFetchInFlight = (async () => {
    const qs = filterQueryString();
    const r = await fetch(`/heatmap.json${qs ? `?${qs}` : ''}`);
    if (!r.ok) return [];
    const data = await r.json();
    heatmapPoints = (data.points || []).map(([lat, lng]) => [lat, lng, 1]);
    return heatmapPoints;
  })();
  try { return await heatmapFetchInFlight; }
  finally { heatmapFetchInFlight = null; }
}

function _disposeHeatmap() {
  if (heatmapLayer && map.hasLayer(heatmapLayer)) map.removeLayer(heatmapLayer);
  heatmapLayer = null;
}

async function applyHeatmapVisibility() {
  const wanted = document.getElementById('heatmap-toggle')?.checked;
  const inTrackZoom = map.getZoom() >= HEX_ZOOM_THRESHOLD;
  // Heatmap is suppressed while a match is active — switching back to
  // exploring mode (clearMatches) un-suppresses and re-applies.
  if (!wanted || !inTrackZoom || heatmapClickSuppressed || !window.L.heatLayer) {
    _disposeHeatmap();
    return;
  }
  const pts = await loadHeatmapPoints();
  // Recreate the layer each time it goes on — reusing a once-removed
  // L.heatLayer raced its internal rAF against the null `_map`, throwing
  // "Cannot read properties of null (reading '_animating')".
  _disposeHeatmap();
  heatmapLayer = L.heatLayer(pts, {
    radius: 18, blur: 22, minOpacity: 0.25, maxZoom: 17,
  });
  heatmapLayer.addTo(map);
}

function invalidateHeatmapData() {
  heatmapPoints = null;
  if (heatmapLayer) {
    if (map.hasLayer(heatmapLayer)) map.removeLayer(heatmapLayer);
    heatmapLayer = null;
  }
}

// ---- Library stats -------------------------------------------------------

function renderYearChart(yearly) {
  if (!yearly.length) return '';
  const minY = yearly[0].year, maxY = yearly[yearly.length - 1].year;
  const byYear = new Map(yearly.map(y => [y.year, y]));
  const series = [];
  for (let y = minY; y <= maxY; y++) {
    series.push(byYear.get(y) || { year: y, road: 0, trail: 0, hike: 0 });
  }

  const w = 300, h = 80, pad = 18;
  const barW = (w - 4) / series.length;
  const max = Math.max(...series.map(s => (s.road || 0) + (s.trail || 0) + (s.hike || 0)), 1);
  const ROAD = '#1f77b4', TRAIL = '#16a34a', HIKE = '#d97706';
  let svg = `<svg viewBox="0 0 ${w} ${h + pad}" class="year-chart" preserveAspectRatio="xMidYMid meet">`;
  series.forEach((s, i) => {
    const x = 2 + i * barW;
    const total = (s.road || 0) + (s.trail || 0) + (s.hike || 0);
    const roadH = (s.road / max) * h;
    const trailH = (s.trail / max) * h;
    const hikeH = ((s.hike || 0) / max) * h;
    const fullH = roadH + trailH + hikeH;
    if (total === 0) {
      svg += `<rect class="gap" x="${x + 1}" y="${h - 1}" width="${barW - 2}" height="1"><title>${s.year}: 0</title></rect>`;
    } else {
      // road sits at the base, trail stacks on top, hike above that
      svg += `<rect x="${x + 1}" y="${h - roadH}" width="${barW - 2}" height="${roadH}" fill="${ROAD}"><title>${s.year}: ${s.road} road</title></rect>`;
      svg += `<rect x="${x + 1}" y="${h - roadH - trailH}" width="${barW - 2}" height="${trailH}" fill="${TRAIL}"><title>${s.year}: ${s.trail} trail</title></rect>`;
      svg += `<rect x="${x + 1}" y="${h - fullH}" width="${barW - 2}" height="${hikeH}" fill="${HIKE}"><title>${s.year}: ${s.hike || 0} hike</title></rect>`;
      svg += `<text x="${x + barW/2}" y="${h - fullH - 2}" text-anchor="middle" font-size="9" fill="#444">${total}</text>`;
    }
    if (series.length <= 12 || i % 2 === 0) {
      svg += `<text x="${x + barW/2}" y="${h + 12}" text-anchor="middle" font-size="9" fill="#777">${s.year}</text>`;
    }
  });
  svg += '</svg>';
  svg += `<div class="chart-legend">
    <span><span class="swatch" style="background:${ROAD}"></span>Road</span>
    <span><span class="swatch" style="background:${TRAIL}"></span>Trail</span>
    <span><span class="swatch" style="background:${HIKE}"></span>Hike</span>
  </div>`;
  return svg;
}

async function loadStats() {
  const qs = hikeMinKm != null ? `?hike_min_km=${hikeMinKm}` : '';
  const r = await fetch(`/stats${qs}`);
  const s = await r.json();
  // Advertise the server default; the input shows it as a placeholder so an
  // empty box reads as "using the default".
  const hikeInput = document.getElementById('hike-min-km');
  if (hikeInput && s.hike_min_km_default != null) {
    hikeInput.placeholder = String(s.hike_min_km_default);
  }
  const div = document.getElementById('stats-content');
  if (!s.count) {
    div.innerHTML = '<p class="muted">No data yet. Import a Strava ZIP or sync below.</p>';
    return;
  }
  const first = s.earliest ? s.earliest.slice(0, 10) : '?';
  const last = s.latest ? s.latest.slice(0, 10) : '?';
  div.innerHTML = `
    <p class="stats-summary"><strong>${s.count}</strong> activities · ${first} → ${last}</p>
    ${renderYearChart(s.yearly)}
  `;
}

// Auto-open settings the first time, when there's nothing imported yet.
async function maybeAutoOpenSettings() {
  const { count } = await (await fetch('/count')).json();
  if (count === 0) openSettings();
}

// ---- Init ----------------------------------------------------------------

async function applyURLState({ animate } = { animate: false }) {
  const saved = loadSavedState();
  _restoringState = true;

  const prevFilterKey = JSON.stringify([polygonFilter, activeFilters, hikeMinKm]);

  // Reset filters from URL
  polygonFilter = saved?.polygonFilter || null;
  polygonBounds = null;
  activeFilters = {
    date_start: saved?.filterDateStart || null,
    date_end: saved?.filterDateEnd || null,
    type: saved?.filterType || null,
    min_km: saved?.filterMinKm ?? null,
    max_km: saved?.filterMaxKm ?? null,
    gear: saved?.filterGear || null,
  };
  hikeMinKm = saved?.hikeMinKm ?? null;
  const hikeInput = document.getElementById('hike-min-km');
  if (hikeInput) hikeInput.value = hikeMinKm != null ? String(hikeMinKm) : '';
  // "All pills off" is client-only and never serialised into the hash, so a
  // restored URL is by definition not in that state. Without this reset,
  // browser-back after all-off leaves the ghost notice over live pills.
  _allTypesOff = false;
  renderFilterChips();
  _syncTypePills();
  invalidateHeatmapData();
  drawnItems.clearLayers();
  if (polygonFilter) {
    const m = polygonFilter.match(/POLYGON\(\((.+)\)\)/);
    if (m) {
      const pts = m[1].split(',').map(s => {
        const [lng, lat] = s.trim().split(/\s+/).map(Number);
        return [lat, lng];
      });
      const poly = L.polygon(pts, { color: '#d62728', weight: 2, fill: false });
      drawnItems.addLayer(poly);
      polygonBounds = poly.getBounds();
      showPolygonCloseBtn();
    }
  } else {
    hidePolygonCloseBtn();
  }
  const lock = document.getElementById('lock-to-track');
  if (lock) lock.checked = saved ? !!saved.lockToTrack : true;
  const zoomFit = document.getElementById('zoom-to-fit-matches');
  if (zoomFit) zoomFit.checked = !!saved?.zoomToFit;
  const dim = document.getElementById('dim-opacity');
  const dimVal = saved?.dimOpacity ?? 45;
  if (dim) {
    dim.value = String(dimVal);
    const dimLabel = document.getElementById('dim-opacity-label');
    if (dimLabel) dimLabel.textContent = String(dimVal);
  }

  // Base layer + opacity
  const baseSel = document.getElementById('base-layer');
  const baseName = saved?.baseLayer || 'Topo (OpenTopoMap)';
  if (baseSel && baseSel.value !== baseName) baseSel.value = baseName;
  setBaseLayer(baseName);
  const opacitySlider = document.getElementById('base-opacity');
  const opacityVal = saved?.baseOpacity ?? 50;
  if (opacitySlider) {
    opacitySlider.value = String(opacityVal);
    document.getElementById('opacity-label').textContent = String(opacityVal);
    setBaseOpacity(opacityVal);
  }
  // Search radius
  const srSlider = document.getElementById('search-radius');
  const srVal = saved?.searchRadius ?? 0;
  if (srSlider) {
    srSlider.value = String(srVal);
    document.getElementById('search-radius-label').textContent = srVal > 0 ? `${srVal} m` : 'auto';
  }

  const newFilterKey = JSON.stringify([polygonFilter, activeFilters, hikeMinKm]);
  const filterChanged = newFilterKey !== prevFilterKey;
  const haveSavedView = saved && saved.center && Array.isArray(saved.center) && saved.zoom != null;

  // Heatmap toggle reflects saved hash before applyZoomMode decides to add it.
  const heat = document.getElementById('heatmap-toggle');
  if (heat) heat.checked = !!saved?.heatmap;

  if (filterChanged || indexById.size === 0) await loadData();
  if (haveSavedView) {
    map.setView(L.latLng(saved.center[0], saved.center[1]), saved.zoom, { animate });
  } else {
    flyToLastRun();
  }

  applyZoomMode();

  // Re-apply polygon / click highlight after tracks are loaded.
  clearMatches();
  if (polygonFilter && polygonBounds) {
    const matches = await fetchPolygonMatches();
    if (matches.length) renderMatches(matches, polygonBounds.getCenter());
  } else if (saved?.clickLatLng) {
    // Restore the active click pin + matches the user had before reload.
    await queryPoint(saved.clickLatLng[0], saved.clickLatLng[1]);
    if (saved.matchId != null && currentEmphasise) {
      currentEmphasise(saved.matchId, { force: true });
    }
  }

  _restoringState = false;
}

window.addEventListener('popstate', () => applyURLState({ animate: true }));

(async () => {
  await Promise.all([loadFilterOptions(), loadAllActivities()]);
  await applyURLState({ animate: false });

  await refreshStravaUI();
  await loadStats();
  await maybeAutoOpenSettings();
  saveState();
})();
