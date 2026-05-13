// ---- Map setup -----------------------------------------------------------

const map = L.map('map', {
  preferCanvas: true,           // canvas renderer = sharper many-track rendering
}).setView([54, -2], 6);
// Inspection API for the Playwright smoke tests. Read-only — tests assert on
// layer presence and match counts without poking module-local variables.
window.__rm = {
  map,
  matchCount: () => matchLayersById.size,
  heatmapOn: () => !!heatmapLayer && map.hasLayer(heatmapLayer),
  hexOn: () => !!hexLayer && map.hasLayer(hexLayer),
  aggregateOn: () => !!aggregateLayer && map.hasLayer(aggregateLayer),
};

const _osmAttr = '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>';
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
let activeBaseLayer = baseLayers['Topo (OpenTopoMap)'];
activeBaseLayer.setOpacity(0.5);
activeBaseLayer.addTo(map);

function setBaseLayer(name) {
  const next = baseLayers[name];
  if (!next || next === activeBaseLayer) return;
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
        for (const id of ['view-menu', 'display-menu']) {
          if (id !== menuId) document.getElementById(id).classList.add('hidden');
        }
        menu.classList.toggle('hidden');
      });
      return div;
    },
  });
}

map.addControl(new (makeMenuControl('⟲', 'View / reset', 'view-menu'))());
map.addControl(new (makeMenuControl('🗺', 'Display', 'display-menu', '16px'))());

// Close map-anchored menus when clicking outside.
document.addEventListener('click', e => {
  for (const id of ['view-menu', 'display-menu', 'filter-menu']) {
    const menu = document.getElementById(id);
    if (menu.classList.contains('hidden')) continue;
    if (e.target.closest(`#${id}`)) continue;
    if (e.target.closest('.leaflet-control')) continue;
    if (id === 'filter-menu' && e.target.closest('#add-filter')) continue;
    menu.classList.add('hidden');
  }
});

// Path styling.
// The aggregate layer is one big GeoJSON of every road/trail you've run —
// a "street map of your runs". Single blue line, no per-track casing.
const STYLE_AGG = { color: '#1a5a8a', weight: 2.5, opacity: 0.85 };
const STYLE_AGG_DIM = { color: '#1a5a8a', weight: 1.8, opacity: 0.25 };
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

let aggregateLayer = null;          // L.geoJSON drawn at z >= HEX_ZOOM_THRESHOLD
let aggregateSegments = [];         // [[lat,lng],[lat,lng]] pairs, for snap-to-track
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
let currentPreset = 'recent90'; // 'all' | 'recent90' | 'dense' — default to recent
let polygonFilter = null;       // WKT POLYGON, or null
let polygonBounds = null;       // L.latLngBounds of the drawn shape
let prePinView = null;          // map view saved when a track is pinned

// Attribute filters (set by the chip bar). Empty means "no filter".
let activeFilters = {
  years: [],         // [2024, 2025]
  type: null,        // 'Run' | 'TrailRun' | null
  min_km: null,      // numbers; null = no bound
  max_km: null,
};

function filterQueryString() {
  const p = new URLSearchParams();
  if (activeFilters.years.length) p.set('years', activeFilters.years.join(','));
  if (activeFilters.type) p.set('type', activeFilters.type);
  if (activeFilters.min_km != null) p.set('min_km', activeFilters.min_km);
  if (activeFilters.max_km != null) p.set('max_km', activeFilters.max_km);
  return p.toString();
}

function hasActiveFilters() {
  return !!(activeFilters.years.length || activeFilters.type
            || activeFilters.min_km != null || activeFilters.max_km != null);
}

// ---- Persistent view state (URL hash, so views are shareable) -----------

let _restoringState = false;

function _currentHash() {
  const c = map.getCenter();
  const p = new URLSearchParams();
  p.set('z', map.getZoom().toString());
  p.set('ll', `${c.lat.toFixed(5)},${c.lng.toFixed(5)}`);
  if (currentPreset !== 'all') p.set('preset', currentPreset);
  if (polygonFilter) p.set('poly', polygonFilter);
  if (activeFilters.years.length) p.set('fyears', activeFilters.years.join(','));
  if (activeFilters.type) p.set('ftype', activeFilters.type);
  if (activeFilters.min_km != null) p.set('fmin', activeFilters.min_km);
  if (activeFilters.max_km != null) p.set('fmax', activeFilters.max_km);
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
    preset: p.get('preset') || 'all',
    polygonFilter: p.get('poly') || null,
    lockToTrack: p.get('lock') !== '0',
    zoomToFit: p.get('zfit') === '1',
    heatmap: p.get('hm') === '1',
    filterYears: p.get('fyears') ? p.get('fyears').split(',').map(Number).filter(n => !isNaN(n)) : [],
    filterType: p.get('ftype') || null,
    filterMinKm: p.get('fmin') ? Number(p.get('fmin')) : null,
    filterMaxKm: p.get('fmax') ? Number(p.get('fmax')) : null,
    baseLayer: p.get('base') || 'Topo (OpenTopoMap)',
    baseOpacity: p.get('op') ? parseInt(p.get('op'), 10) : 50,
    searchRadius: p.get('sr') ? parseInt(p.get('sr'), 10) : 0,
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

async function applyPreset(name) {
  pushHistoryCheckpoint();
  currentPreset = name;
  document.getElementById('view-menu').classList.add('hidden');
  autoMatchSuppressed = false;
  await loadData();
  fitView();
  applyZoomMode();
  saveState();
  if (name === 'recent90') {
    showToast('Showing runs from the last 90 days. Use the ⟲ menu to change.');
  } else {
    hideToast();
  }
}

document.querySelectorAll('#view-menu button').forEach(btn => {
  btn.onclick = () => applyPreset(btn.dataset.view);
});

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

async function loadAggregate() {
  if (aggregateLayer) { map.removeLayer(aggregateLayer); aggregateLayer = null; }
  aggregateSegments = [];
  const qs = filterQueryString();
  const r = await fetch(`/aggregate.geojson${qs ? `?${qs}` : ''}`);
  if (!r.ok) return false;
  const gj = await r.json();
  const feat = gj.features?.[0];
  if (!feat || !feat.geometry) return false;
  const coords = feat.geometry.coordinates || [];
  // Store [[lat,lng],[lat,lng]] pairs for snap-to-track lookups.
  for (const seg of coords) {
    if (seg.length >= 2) {
      aggregateSegments.push([[seg[0][1], seg[0][0]], [seg[1][1], seg[1][0]]]);
    }
  }
  aggregateLayer = L.geoJSON(gj, { style: () => STYLE_AGG, interactive: false });
  // The aggregate is only shown at z >= HEX_ZOOM_THRESHOLD; applyZoomMode
  // decides whether to add it to the map.
  return true;
}

function percentile(sorted, p) {
  const k = (sorted.length - 1) * p;
  const lo = Math.floor(k), hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (k - lo);
}

function _activityCentroid(a) {
  // bbox is [minlon, minlat, maxlon, maxlat]
  return { lon: (a.bbox[0] + a.bbox[2]) / 2, lat: (a.bbox[1] + a.bbox[3]) / 2,
           time: a.start_time ? new Date(a.start_time).getTime() : null };
}

function fitView() {
  if (!indexById.size) return;
  const all = [];
  for (const a of indexById.values()) all.push(_activityCentroid(a));

  let subset = all;
  if (currentPreset === 'recent90') {
    const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
    const recent = all.filter(c => c.time != null && c.time >= cutoff);
    if (recent.length >= 1) subset = recent;
  } else if (currentPreset === 'dense') {
    const lats = all.map(c => c.lat).sort((a, b) => a - b);
    const lons = all.map(c => c.lon).sort((a, b) => a - b);
    const q1Lat = percentile(lats, 0.25), q3Lat = percentile(lats, 0.75);
    const q1Lon = percentile(lons, 0.25), q3Lon = percentile(lons, 0.75);
    const iqrLat = q3Lat - q1Lat;
    const iqrLon = q3Lon - q1Lon;
    const loLat = q1Lat - 1.5 * iqrLat, hiLat = q3Lat + 1.5 * iqrLat;
    const loLon = q1Lon - 1.5 * iqrLon, hiLon = q3Lon + 1.5 * iqrLon;
    const inliers = all.filter(c =>
      c.lat >= loLat && c.lat <= hiLat && c.lon >= loLon && c.lon <= hiLon
    );
    if (inliers.length >= 2) subset = inliers;
  }

  const lats = subset.map(c => c.lat);
  const lons = subset.map(c => c.lon);
  const bounds = [
    [Math.min(...lats), Math.min(...lons)],
    [Math.max(...lats), Math.max(...lons)],
  ];
  map.fitBounds(bounds, { padding: [30, 30] });
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
      layer.bindTooltip(`${n} run${n === 1 ? '' : 's'}`, { sticky: true, opacity: 0.9 });
      layer.on('mouseover', () => layer.setStyle({ weight: 2, color: '#222' }));
      layer.on('mouseout',  () => layer.setStyle({ weight: 0.6, color: '#ffffff' }));
      layer.on('click', e => {
        L.DomEvent.stopPropagation(e);
        pushHistoryCheckpoint();
        const tBounds = boundsOfTracksInHex(res, feat.properties.cell);
        const target = tBounds || layer.getBounds();
        map.flyToBounds(target, {
          maxZoom: 16,
          padding: [40, 40],
          duration: 0.7,
        });
      });
    },
  }).addTo(map);
}

function applyZoomMode() {
  // If h3-js failed to load, never go into hex mode — just show aggregate.
  const useTracks = map.getZoom() >= HEX_ZOOM_THRESHOLD || !window.h3;
  if (useTracks) {
    if (hexLayer) { map.removeLayer(hexLayer); hexLayer = null; }
    if (aggregateLayer && !map.hasLayer(aggregateLayer)) aggregateLayer.addTo(map);
    applyHeatmapVisibility();
  } else {
    if (aggregateLayer && map.hasLayer(aggregateLayer)) map.removeLayer(aggregateLayer);
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
  renderMatches(matches, lastClickLatLng);
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
    const casing = L.polyline(m.geometry, STYLE_DENSITY_CASING);
    const line = L.polyline(m.geometry, STYLE_DENSITY);
    line.on('mouseover', () => { map.getContainer().style.cursor = 'pointer'; });
    line.on('mouseout',  () => { map.getContainer().style.cursor = ''; });
    matchCasingsById.set(m.id, casing);
    matchLayersById.set(m.id, line);
    casing.addTo(map);
    line.addTo(map);
  }
}

// Strava's own activity icons (Run / TrailRun), inlined.
const ICON_ROAD = `<svg class="ti road" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><title>Road run</title><path fill="currentColor" d="M8.688 0C8.025 0 7.38.215 6.85.613l-3.32 2.49-2.845.948A1 1 0 000 5c0 1.579.197 2.772.567 3.734.376.978.907 1.654 1.476 2.223.305.305.6.567.886.82.785.697 1.5 1.33 2.159 2.634 1.032 2.57 2.37 4.748 4.446 6.27C11.629 22.218 14.356 23 18 23c2.128 0 3.587-.553 4.549-1.411a4.378 4.378 0 001.408-2.628c.152-.987-.389-1.787-.967-2.25l-3.892-3.114a1 1 0 01-.329-.477l-3.094-9.726A2 2 0 0013.769 2h-1.436a2 2 0 00-1.2.4l-.57.428-.516-1.803A1.413 1.413 0 008.688 0zM8.05 2.213c.069-.051.143-.094.221-.127l1.168 4.086L12.333 4h1.436l.954 3H12v2h3.36l.318 1H13v2h3.314l.55 1.726a3 3 0 00.984 1.433l3.106 2.485c-.77.19-1.778.356-2.954.356-1.97 0-3.178-.431-4.046-1.087-.895-.677-1.546-1.675-2.251-3.056-.224-.437-.45-.907-.688-1.403C9.875 10.08 8.444 7.1 5.531 4.102zM3.743 5.14c2.902 2.858 4.254 5.664 5.441 8.126.25.517.49 1.018.738 1.502.732 1.432 1.55 2.777 2.827 3.74C14.053 19.495 15.72 20 18 20c1.492 0 2.754-.23 3.684-.479a2.285 2.285 0 01-.467.575c-.5.446-1.435.904-3.217.904-3.356 0-5.629-.718-7.284-1.931-1.663-1.22-2.823-3.028-3.788-5.44a1.012 1.012 0 00-.034-.076c-.853-1.708-1.947-2.673-2.79-3.417a14.61 14.61 0 01-.647-.593c-.431-.431-.775-.88-1.024-1.527-.21-.545-.367-1.271-.417-2.3z"/></svg>`;
const ICON_TRAIL = `<svg class="ti trail" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><title>Trail run</title><path fill="currentColor" d="M8.688 0C8.025 0 7.38.215 6.85.613l-3.32 2.49-2.845.948A1 1 0 000 5c0 1.579.197 2.772.567 3.734.376.978.907 1.654 1.476 2.223.305.305.6.567.886.82.785.697 1.5 1.33 2.159 2.634 1.032 2.57 2.37 4.748 4.446 6.27.15.11.303.217.46.319h-2.58l-2.707-2.707a1 1 0 00-1.414 0L3 18.586l-1.5-1.5L.086 18.5l2.207 2.207a1 1 0 001.414 0L4 20.414l2.293 2.293A1 1 0 007 23h11c2.128 0 3.587-.553 4.549-1.411a4.378 4.378 0 001.408-2.628c.152-.987-.389-1.787-.967-2.25l-3.892-3.114a1 1 0 01-.329-.477l-3.094-9.726A2 2 0 0013.769 2h-1.436a2 2 0 00-1.2.4l-.57.428-.516-1.803A1.413 1.413 0 008.688 0zM18 21c-3.356 0-5.629-.718-7.284-1.931-1.663-1.22-2.823-3.028-3.788-5.44a1.012 1.012 0 00-.034-.076c-.853-1.708-1.947-2.673-2.79-3.417-.24-.212-.46-.405-.647-.593-.431-.431-.775-.88-1.024-1.527-.21-.545-.367-1.271-.417-2.3l1.323-.442L5 7.351v1.706l.333.299c1.11.992 2.452 2.512 3.933 4.839 1.356 2.132 3.156 3.553 5.26 4.685l.222.12h7.156c-.105.36-.307.758-.687 1.096-.5.446-1.435.904-3.217.904zM5.175 4.368L8.05 2.213c.069-.051.143-.094.221-.127l1.168 4.086L12.333 4h1.436l.954 3H10v1.934l3.11 3.391-.724 1.014L13.454 15h4.21c.06.055.12.108.184.16L20.15 17h-4.893c-1.793-.996-3.223-2.182-4.303-3.88C9.526 10.88 8.188 9.295 7 8.172V6.65zM15.36 9l.039.122-1.1 1.54L12.774 9zm.796 2.502L16.632 13h-1.546z"/></svg>`;

function typeIcon(type) {
  if (type === 'TrailRun') return ICON_TRAIL;
  if (type === 'Run')      return ICON_ROAD;
  return '';
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
    <td class="name"><a href="#" class="open-preview" data-id="${m.id}">${escapeHTML(name)}</a></td>
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
    layer.bindTooltip(
      `${icon} <strong>${date}</strong> · ${km} km<br><span style="color:#666">${name}</span>`,
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
  if (aggregateLayer && map.hasLayer(aggregateLayer)) aggregateLayer.setStyle(STYLE_AGG_DIM);
  // Heatmap is exploratory — hide it while the user is looking at a match.
  heatmapClickSuppressed = true;
  applyHeatmapVisibility();

  if (!matches.length) {
    matchesPanelOpen = true;
    document.getElementById('matches-content').innerHTML =
      '<p class="muted" style="margin:4px 0">No runs here at this radius.</p>';
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
  const html = `<table class="matches-table"><tbody>${matches.map(rowHtml).join('')}</tbody></table>`;
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
  clearMatchLayers();
  hidePreview();
  // Aggregate returns to full prominence once nothing is matched.
  if (aggregateLayer && map.hasLayer(aggregateLayer)) aggregateLayer.setStyle(STYLE_AGG);
  // Heatmap was hidden while match was active — restore if toggle is on.
  heatmapClickSuppressed = false;
  applyHeatmapVisibility();
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

  return `
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
    ${photo ? `<img class="preview-photo" src="${photo}" alt="">` : ''}
  `;
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
  'base-layer', 'base-opacity', 'search-radius',
]);
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

map.on('click', e => {
  if (isDrawing) return;
  // In hex (low-zoom) mode the hex feature's own click already handles drill-in;
  // ignore stray map clicks.
  if (map.getZoom() < HEX_ZOOM_THRESHOLD) return;
  if (e.originalEvent.target && e.originalEvent.target.closest('.leaflet-control')) return;
  if (e.originalEvent.target && e.originalEvent.target.closest('.leaflet-draw-toolbar')) return;

  // An explicit user click counts as "engagement" — un-suppress auto-match.
  autoMatchSuppressed = false;

  let target = e.latlng;
  if (document.getElementById('lock-to-track').checked) {
    const snapped = snapToNearestTrack(e.latlng);
    if (snapped) target = snapped;
  }

  const r = currentRadiusMetres();
  clearClickGraphics();
  clickRadiusCircle = L.circle(target, {
    radius: r,
    color: '#0891b2', weight: 1.5, opacity: 0.85,
    fillColor: '#0891b2', fillOpacity: 0.08,
  }).addTo(map);
  // Pin-shaped marker so the search point stays visible at any zoom level
  // (a circleMarker can disappear inside the radius circle when zoomed out).
  const pinHtml = `<svg viewBox="0 0 24 32" width="22" height="29" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 20 12 20s12-11 12-20c0-6.6-5.4-12-12-12z" fill="#0891b2" stroke="#fff" stroke-width="2"/>
    <circle cx="12" cy="12" r="4" fill="#fff"/>
  </svg>`;
  clickMarker = L.marker(target, {
    icon: L.divIcon({ html: pinHtml, className: 'click-pin', iconSize: [22, 29], iconAnchor: [11, 29] }),
    interactive: false, keyboard: false, zIndexOffset: 800,
  }).addTo(map);
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
  } else {
    map.flyToBounds(polygonBounds, { padding: [40, 40], maxZoom: 17, duration: 0.6 });
  }
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
      fitView();
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
      fitView();
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
document.getElementById('matches-close').onclick = () => {
  autoMatchSuppressed = true;
  autoMatchedId = null;
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


// Heatmap overlay toggle — separate density layer (proper kernel) on top of
// the aggregate. Visible only at z >= HEX_ZOOM_THRESHOLD.
document.getElementById('heatmap-toggle')?.addEventListener('change', () => {
  applyHeatmapVisibility();
  saveState();
});

// ---- Filter chip bar ----------------------------------------------------

let _filterOptions = { years: [], types: [] };

async function loadFilterOptions() {
  try {
    _filterOptions = await (await fetch('/filter-options')).json();
  } catch { /* leave defaults */ }
}

function renderFilterChips() {
  const host = document.getElementById('filter-chips');
  const chips = [];
  if (activeFilters.years.length) {
    chips.push({ key: 'years', label: activeFilters.years.join(', ') });
  }
  if (activeFilters.type) {
    chips.push({ key: 'type', label: activeFilters.type === 'TrailRun' ? 'Trail' : 'Road' });
  }
  if (activeFilters.min_km != null || activeFilters.max_km != null) {
    const lo = activeFilters.min_km != null ? `≥${activeFilters.min_km}` : '';
    const hi = activeFilters.max_km != null ? `<${activeFilters.max_km}` : '';
    const sep = lo && hi ? ' & ' : '';
    chips.push({ key: 'dist', label: `${lo}${sep}${hi} km` });
  }
  host.innerHTML = chips.map(c =>
    `<span class="chip" data-key="${c.key}">${escapeHTML(c.label)}<span class="x" title="Remove">×</span></span>`
  ).join('');
  for (const el of host.querySelectorAll('.chip .x')) {
    el.addEventListener('click', () => {
      const key = el.parentElement.dataset.key;
      if (key === 'years') activeFilters.years = [];
      if (key === 'type') activeFilters.type = null;
      if (key === 'dist') { activeFilters.min_km = null; activeFilters.max_km = null; }
      applyFilters();
    });
  }
}

function populateFilterMenu() {
  const yearSel = document.getElementById('filter-year');
  const have = new Set(Array.from(yearSel.options).map(o => Number(o.value)));
  for (const y of _filterOptions.years) {
    if (!have.has(y)) {
      const opt = document.createElement('option');
      opt.value = String(y); opt.textContent = String(y);
      yearSel.appendChild(opt);
    }
  }
  // Reflect active state in the form controls.
  for (const opt of yearSel.options) {
    opt.selected = activeFilters.years.includes(Number(opt.value));
  }
  document.getElementById('filter-type').value = activeFilters.type || '';
  document.getElementById('filter-min-km').value = activeFilters.min_km ?? '';
  document.getElementById('filter-max-km').value = activeFilters.max_km ?? '';
}

document.getElementById('add-filter').addEventListener('click', e => {
  e.stopPropagation();
  const menu = document.getElementById('filter-menu');
  const btn = e.currentTarget;
  const rect = btn.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 6}px`;
  menu.style.left = `${Math.max(8, rect.left - 80)}px`;
  populateFilterMenu();
  // Close other menus.
  for (const id of ['view-menu', 'display-menu']) document.getElementById(id).classList.add('hidden');
  menu.classList.toggle('hidden');
});

document.getElementById('filter-apply').addEventListener('click', () => {
  const yearSel = document.getElementById('filter-year');
  activeFilters.years = Array.from(yearSel.selectedOptions).map(o => Number(o.value));
  activeFilters.type = document.getElementById('filter-type').value || null;
  const minV = document.getElementById('filter-min-km').value;
  const maxV = document.getElementById('filter-max-km').value;
  activeFilters.min_km = minV === '' ? null : Number(minV);
  activeFilters.max_km = maxV === '' ? null : Number(maxV);
  document.getElementById('filter-menu').classList.add('hidden');
  applyFilters();
});

document.getElementById('filter-clear').addEventListener('click', () => {
  activeFilters = { years: [], type: null, min_km: null, max_km: null };
  document.getElementById('filter-menu').classList.add('hidden');
  applyFilters();
});

async function applyFilters() {
  pushHistoryCheckpoint();
  renderFilterChips();
  // Filters change the data underlying every layer + match. Reload everything.
  invalidateHeatmapData();
  await loadData();
  // Re-run any in-flight matches against the new filter set.
  if (lastMatches.length && lastClickLatLng) {
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
    if (heatmapLayer && map.hasLayer(heatmapLayer)) map.removeLayer(heatmapLayer);
    return;
  }
  const pts = await loadHeatmapPoints();
  if (!heatmapLayer) {
    heatmapLayer = L.heatLayer(pts, {
      radius: 18, blur: 22, minOpacity: 0.25, maxZoom: 17,
    });
  } else {
    heatmapLayer.setLatLngs(pts);
  }
  if (!map.hasLayer(heatmapLayer)) heatmapLayer.addTo(map);
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
    series.push(byYear.get(y) || { year: y, road: 0, trail: 0 });
  }

  const w = 300, h = 80, pad = 18;
  const barW = (w - 4) / series.length;
  const max = Math.max(...series.map(s => (s.road || 0) + (s.trail || 0)), 1);
  const ROAD = '#1f77b4', TRAIL = '#16a34a';
  let svg = `<svg viewBox="0 0 ${w} ${h + pad}" class="year-chart" preserveAspectRatio="xMidYMid meet">`;
  series.forEach((s, i) => {
    const x = 2 + i * barW;
    const total = (s.road || 0) + (s.trail || 0);
    const roadH = (s.road / max) * h;
    const trailH = (s.trail / max) * h;
    const fullH = roadH + trailH;
    if (total === 0) {
      svg += `<rect class="gap" x="${x + 1}" y="${h - 1}" width="${barW - 2}" height="1"><title>${s.year}: 0</title></rect>`;
    } else {
      // road sits at the base, trail stacks on top
      svg += `<rect x="${x + 1}" y="${h - roadH}" width="${barW - 2}" height="${roadH}" fill="${ROAD}"><title>${s.year}: ${s.road} road</title></rect>`;
      svg += `<rect x="${x + 1}" y="${h - fullH}" width="${barW - 2}" height="${trailH}" fill="${TRAIL}"><title>${s.year}: ${s.trail} trail</title></rect>`;
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
  </div>`;
  return svg;
}

async function loadStats() {
  const r = await fetch('/stats');
  const s = await r.json();
  const div = document.getElementById('stats-content');
  if (!s.count) {
    div.innerHTML = '<p class="muted">No data yet. Import a Strava ZIP or sync below.</p>';
    return;
  }
  const first = s.earliest ? s.earliest.slice(0, 10) : '?';
  const last = s.latest ? s.latest.slice(0, 10) : '?';
  div.innerHTML = `
    <p class="stats-summary"><strong>${s.count}</strong> runs · ${first} → ${last}</p>
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

  const prevFilterKey = JSON.stringify([currentPreset, polygonFilter, activeFilters]);

  // Reset filters from URL
  currentPreset = saved?.preset || 'all';
  polygonFilter = saved?.polygonFilter || null;
  polygonBounds = null;
  activeFilters = {
    years: saved?.filterYears || [],
    type: saved?.filterType || null,
    min_km: saved?.filterMinKm ?? null,
    max_km: saved?.filterMaxKm ?? null,
  };
  renderFilterChips();
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

  const newFilterKey = JSON.stringify([currentPreset, polygonFilter, activeFilters]);
  const filterChanged = newFilterKey !== prevFilterKey;
  const haveSavedView = saved && saved.center && Array.isArray(saved.center) && saved.zoom != null;

  // Heatmap toggle reflects saved hash before applyZoomMode decides to add it.
  const heat = document.getElementById('heatmap-toggle');
  if (heat) heat.checked = !!saved?.heatmap;

  if (filterChanged || indexById.size === 0) await loadData();
  if (haveSavedView) {
    map.setView(L.latLng(saved.center[0], saved.center[1]), saved.zoom, { animate });
  } else {
    fitView();
  }

  applyZoomMode();

  // Re-apply polygon highlight after tracks are loaded.
  clearMatches();
  if (polygonFilter && polygonBounds) {
    const matches = await fetchPolygonMatches();
    if (matches.length) renderMatches(matches, polygonBounds.getCenter());
  }

  _restoringState = false;
}

window.addEventListener('popstate', () => applyURLState({ animate: true }));

(async () => {
  const fresh = !location.hash || location.hash.length < 2;
  await loadFilterOptions();
  await applyURLState({ animate: false });

  if (fresh && currentPreset === 'recent90') {
    showToast('Showing runs from the last 90 days. Use the ⟲ menu to change.');
  }

  await refreshStravaUI();
  await loadStats();
  await maybeAutoOpenSettings();
  saveState();
})();
