// ---- Map setup -----------------------------------------------------------

const map = L.map('map', {
  preferCanvas: true,           // canvas renderer = sharper many-track rendering
}).setView([54, -2], 6);

L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  maxZoom: 19,
}).addTo(map);

const drawnItems = new L.FeatureGroup().addTo(map);
map.addControl(new L.Control.Draw({
  draw: { polyline: false, circle: false, marker: false, circlemarker: false },
  edit: { featureGroup: drawnItems, edit: false },
}));

// Locate-me button
const LocateBtn = L.Control.extend({
  options: { position: 'topleft' },
  onAdd() {
    const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
    const a = L.DomUtil.create('a', '', div);
    a.href = '#'; a.title = 'My location'; a.textContent = '📍';
    a.style.fontSize = '18px'; a.style.lineHeight = '26px'; a.style.textAlign = 'center';
    L.DomEvent.on(a, 'click', e => {
      L.DomEvent.preventDefault(e);
      map.locate({ setView: true, maxZoom: 14 });
    });
    return div;
  },
});
map.addControl(new LocateBtn());

// View / reset menu — opens a small slide-out next to the button.
const ViewMenuBtn = L.Control.extend({
  options: { position: 'topleft' },
  onAdd() {
    const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
    const a = L.DomUtil.create('a', '', div);
    a.href = '#'; a.title = 'View / reset'; a.textContent = '⟲';
    a.style.fontSize = '18px'; a.style.lineHeight = '26px'; a.style.textAlign = 'center';
    L.DomEvent.on(a, 'click', e => {
      L.DomEvent.preventDefault(e);
      const menu = document.getElementById('view-menu');
      const rect = a.getBoundingClientRect();
      menu.style.top = `${rect.bottom + 6}px`;
      menu.style.left = `${rect.left}px`;
      menu.classList.toggle('hidden');
    });
    return div;
  },
});
map.addControl(new ViewMenuBtn());

// Close view menu when clicking outside
document.addEventListener('click', e => {
  const menu = document.getElementById('view-menu');
  if (menu.classList.contains('hidden')) return;
  if (e.target.closest('#view-menu')) return;
  if (e.target.closest('.leaflet-control')) return;
  menu.classList.add('hidden');
});

// Path styling — keep visible when zoomed out. Two-layer trick: white casing
// underneath, coloured line on top. Stacked opacity on overlapping tracks
// naturally produces a heat-map effect for popular routes.
const STYLE_CASING = { color: '#ffffff', weight: 4, opacity: 0.6 };
const STYLE_BASE = { color: '#1a5a8a', weight: 2, opacity: 0.65 };
const STYLE_MATCH_CASING = { color: '#ffffff', weight: 7, opacity: 0.9 };
const STYLE_MATCH = { color: '#d62728', weight: 4.5, opacity: 0.95 };
// Subtle yellow halo for the hovered row.
const STYLE_HOVER_CASING = { color: '#ffd400', weight: 9, opacity: 0.55 };
const STYLE_HOVER = { color: '#d62728', weight: 4.5, opacity: 1 };
// Dimmed look for the OTHER matches when one is hovered.
const STYLE_MATCH_DIM_CASING = { color: '#ffffff', weight: 4, opacity: 0.35 };
const STYLE_MATCH_DIM = { color: '#d62728', weight: 2.5, opacity: 0.35 };

let casingLayer = null;
let tracksLayer = null;
let centroids = [];
let layersById = new Map();
let casingsById = new Map();
let tracksByIndex = [];        // parallel to trackSamples — Leaflet layers
let metaById = new Map();      // id -> { id, start_time, name, distance_m, strava_url }
let autoMatchedId = null;      // the id we're currently auto-displaying, if any
let autoMatchSuppressed = false; // set true when user dismisses a popup
let _programmaticPopupClose = false;
let trackSamples = null;       // [[lat, lng], ...] per track, precomputed
let hexLayer = null;
let hexBinsCache = new Map();  // resolution -> Map<cell, count>
let hexCellToTrackIdxs = new Map(); // resolution -> Map<cell, Set<trackIdx>>
const HEX_ZOOM_THRESHOLD = 11; // <  hex view ; >= tracks view

// Active filtering
let currentPreset = 'recent90'; // 'all' | 'recent90' | 'dense' — default to recent
let yearFilter = null;          // integer year, or null
let polygonFilter = null;       // WKT POLYGON, or null
let polygonBounds = null;       // L.latLngBounds of the drawn shape

// ---- Persistent view state (URL hash, so views are shareable) -----------

let _restoringState = false;

function _currentHash() {
  const c = map.getCenter();
  const p = new URLSearchParams();
  p.set('z', map.getZoom().toString());
  p.set('ll', `${c.lat.toFixed(5)},${c.lng.toFixed(5)}`);
  if (currentPreset !== 'all') p.set('preset', currentPreset);
  if (yearFilter != null) p.set('y', String(yearFilter));
  if (polygonFilter) p.set('poly', polygonFilter);
  const lock = document.getElementById('lock-to-track');
  if (lock && !lock.checked) p.set('lock', '0');
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
    yearFilter: p.get('y') ? parseInt(p.get('y'), 10) : null,
    polygonFilter: p.get('poly') || null,
    lockToTrack: p.get('lock') !== '0',
  };
}
let clickMarker = null;
let clickRadiusCircle = null;
let matchPopup = null;
let lastClickLatLng = null;
let lastMatches = [];

// ---- View presets + year filter -----------------------------------------

function buildTracksQuery() {
  // Presets ('recent90', 'dense') are zoom-only. Polygon is highlight-only
  // (queried separately as a match). The only real data filter on the loaded
  // set is the year (from chart click).
  const params = new URLSearchParams();
  if (yearFilter != null) {
    params.set('from', `${yearFilter}-01-01`);
    params.set('to',   `${yearFilter + 1}-01-01`);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

async function fetchPolygonMatches() {
  if (!polygonFilter) return [];
  const fd = new FormData();
  fd.append('wkt', polygonFilter);
  if (yearFilter != null) {
    fd.append('from', `${yearFilter}-01-01`);
    fd.append('to',   `${yearFilter + 1}-01-01`);
  }
  const r = await fetch('/match/polygon', { method: 'POST', body: fd });
  return r.ok ? r.json() : [];
}

function updateFilterBanner() {
  // Polygon has its own × button on the map; only year-filter goes here.
  const banner = document.getElementById('filter-banner');
  const label = document.getElementById('filter-label');
  if (yearFilter != null) {
    label.textContent = `${yearFilter}`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
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
  if (matchPopup) { const old = matchPopup; matchPopup = null; closePopupProgrammatically(old); }
  clearMatches();
  updateFilterBanner();
  saveState();
}

async function applyPreset(name) {
  pushHistoryCheckpoint();
  currentPreset = name;
  yearFilter = null;
  document.getElementById('view-menu').classList.add('hidden');
  autoMatchSuppressed = false;
  await loadTracks();
  fitView();
  applyZoomMode();
  updateFilterBanner();
  saveState();
  if (name === 'recent90') {
    showToast('Showing runs from the last 90 days. Use the ⟲ menu to change.');
  } else {
    hideToast();
  }
}

async function filterByYear(year) {
  pushHistoryCheckpoint();
  yearFilter = year;
  autoMatchSuppressed = false;
  await loadTracks();
  fitView();
  applyZoomMode();
  updateFilterBanner();
  saveState();
}

async function clearFilter() {
  pushHistoryCheckpoint();
  const hadYear = yearFilter != null;
  yearFilter = null;
  currentPreset = 'all';
  polygonFilter = null;
  polygonBounds = null;
  drawnItems.clearLayers();
  autoMatchSuppressed = false;
  // Close any match popup since the highlighted set just changed.
  if (matchPopup) { const old = matchPopup; matchPopup = null; closePopupProgrammatically(old); }
  clearMatches();
  // Only reload tracks if the year filter (the only real data filter) was
  // active. Otherwise the loaded set is unchanged — leaving the map view
  // exactly where the user left it, per intent.
  if (hadYear) await loadTracks();
  applyZoomMode();
  updateFilterBanner();
  await loadStats();
  saveState();
}

document.querySelectorAll('#view-menu button').forEach(btn => {
  btn.onclick = () => applyPreset(btn.dataset.view);
});
document.getElementById('clear-filter').onclick = clearFilter;

// ---- Auto match radius (scales with zoom) --------------------------------

// Click forgiveness in screen pixels. We translate this into metres at the
// current zoom + latitude, so the match radius always reflects what looks
// "close" on the map.
const CLICK_PIXEL_TOLERANCE = 22;

function metresPerPixel(zoom, lat) {
  return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom + 8);
}

function currentRadiusMetres() {
  const c = map.getCenter();
  const m = metresPerPixel(map.getZoom(), c.lat) * CLICK_PIXEL_TOLERANCE;
  return Math.max(5, Math.min(2000, Math.round(m)));
}

// Match radius is still used for the query, but no longer surfaced as UI.

// ---- Data load -----------------------------------------------------------

async function loadTracks(opts = {}) {
  showSpinner();
  try { return await _loadTracksInner(opts); }
  finally { hideSpinner(); }
}

const _casingOpts = {
  style: STYLE_CASING,
  onEachFeature: (feat, layer) => casingsById.set(feat.properties.id, layer),
};
const _tracksOpts = {
  style: STYLE_BASE,
  onEachFeature: (feat, layer) => {
    layersById.set(feat.properties.id, layer);
    tracksByIndex.push(layer);
    metaById.set(feat.properties.id, feat.properties);
    layer.on('mouseover', () => { map.getContainer().style.cursor = 'pointer'; });
    layer.on('mouseout',  () => { map.getContainer().style.cursor = ''; });
  },
};

function _ingestFeatures(features) {
  for (const f of features) {
    const c = f.geometry.coordinates;
    let lat = 0, lon = 0;
    for (const [x, y] of c) { lat += y; lon += x; }
    const t = f.properties.start_time ? new Date(f.properties.start_time).getTime() : null;
    centroids.push({ lat: lat / c.length, lon: lon / c.length, time: t });
    const step = Math.max(1, Math.floor(c.length / 8));
    const samples = [];
    for (let i = 0; i < c.length; i += step) samples.push([c[i][1], c[i][0]]);
    trackSamples.push(samples);
  }
}

async function _loadTracksInner({ bbox = null, exclude_bbox = null, append = false } = {}) {
  if (!append) {
    if (casingLayer) { map.removeLayer(casingLayer); casingLayer = null; }
    if (tracksLayer) { map.removeLayer(tracksLayer); tracksLayer = null; }
    layersById.clear();
    casingsById.clear();
    tracksByIndex = [];
    metaById.clear();
    centroids = [];
    trackSamples = [];
    clearMatches();
    if (clickMarker) { map.removeLayer(clickMarker); clickMarker = null; }
    if (clickRadiusCircle) { map.removeLayer(clickRadiusCircle); clickRadiusCircle = null; }
  }
  // NOTE: don't clear drawnItems here — it's the user's filter polygon and
  // its lifecycle is owned by the Draw.CREATED handler / clearPolygonFilter().

  // Build URL: combine year filter + bbox params
  const filterQs = buildTracksQuery();
  const params = new URLSearchParams(filterQs.startsWith('?') ? filterQs.slice(1) : '');
  if (bbox) params.set('bbox', bbox);
  if (exclude_bbox) params.set('exclude_bbox', exclude_bbox);
  const qs = params.toString();
  const url = `/tracks.geojson${qs ? `?${qs}` : ''}`;

  const r = await fetch(url);
  const gj = await r.json();
  if (!gj.features.length) {
    hexBinsCache.clear();
    hexCellToTrackIdxs.clear();
    return false;
  }

  _ingestFeatures(gj.features);
  hexBinsCache.clear();
  hexCellToTrackIdxs.clear();

  if (!casingLayer) {
    casingLayer = L.geoJSON(gj, _casingOpts).addTo(map);
  } else {
    casingLayer.addData(gj);
  }
  if (!tracksLayer) {
    tracksLayer = L.geoJSON(gj, _tracksOpts).addTo(map);
  } else {
    tracksLayer.addData(gj);
  }

  return true;
}

function percentile(sorted, p) {
  const k = (sorted.length - 1) * p;
  const lo = Math.floor(k), hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (k - lo);
}

function fitView() {
  if (!centroids.length) return;

  // Pick the subset of centroids that frames the chosen preset. Tracks
  // themselves are always rendered in full — this only shapes the viewport.
  let subset = centroids;
  if (currentPreset === 'recent90') {
    const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
    const recent = centroids.filter(c => c.time != null && c.time >= cutoff);
    if (recent.length >= 1) subset = recent;
  } else if (currentPreset === 'dense') {
    const lats = centroids.map(c => c.lat).sort((a, b) => a - b);
    const lons = centroids.map(c => c.lon).sort((a, b) => a - b);
    const q1Lat = percentile(lats, 0.25), q3Lat = percentile(lats, 0.75);
    const q1Lon = percentile(lons, 0.25), q3Lon = percentile(lons, 0.75);
    const iqrLat = q3Lat - q1Lat;
    const iqrLon = q3Lon - q1Lon;
    const loLat = q1Lat - 1.5 * iqrLat, hiLat = q3Lat + 1.5 * iqrLat;
    const loLon = q1Lon - 1.5 * iqrLon, hiLon = q3Lon + 1.5 * iqrLon;
    const inliers = centroids.filter(c =>
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
  const cellToIdxs = new Map();
  if (!trackSamples || !window.h3) {
    hexBinsCache.set(res, counts);
    hexCellToTrackIdxs.set(res, cellToIdxs);
    return counts;
  }
  for (let idx = 0; idx < trackSamples.length; idx++) {
    const cells = new Set();
    for (const [lat, lng] of trackSamples[idx]) cells.add(h3.latLngToCell(lat, lng, res));
    for (const c of cells) {
      counts.set(c, (counts.get(c) || 0) + 1);
      let s = cellToIdxs.get(c);
      if (!s) { s = new Set(); cellToIdxs.set(c, s); }
      s.add(idx);
    }
  }
  hexBinsCache.set(res, counts);
  hexCellToTrackIdxs.set(res, cellToIdxs);
  return counts;
}

function boundsOfTracksInHex(res, cell) {
  const idxs = hexCellToTrackIdxs.get(res)?.get(cell);
  if (!idxs || !idxs.size) return null;
  let bounds = null;
  for (const idx of idxs) {
    const layer = tracksByIndex[idx];
    if (!layer) continue;
    const b = layer.getBounds();
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
  if (!trackSamples || !window.h3) return;
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
  // If h3-js failed to load, never go into hex mode — just keep tracks.
  const useTracks = map.getZoom() >= HEX_ZOOM_THRESHOLD || !window.h3;
  if (useTracks) {
    if (hexLayer) { map.removeLayer(hexLayer); hexLayer = null; }
    if (casingLayer && !map.hasLayer(casingLayer)) casingLayer.addTo(map);
    if (tracksLayer && !map.hasLayer(tracksLayer)) tracksLayer.addTo(map);
  } else {
    if (casingLayer && map.hasLayer(casingLayer)) map.removeLayer(casingLayer);
    if (tracksLayer && map.hasLayer(tracksLayer)) map.removeLayer(tracksLayer);
    renderHexes();
    // Hex view is for density only — track-level interactions don't apply.
    clearClickGraphics();
    if (matchPopup) { map.closePopup(matchPopup); matchPopup = null; }
  }
}

map.on('zoomend', applyZoomMode);

// ---- Spatial queries -----------------------------------------------------

async function queryPoint(lat, lon) {
  const r = await fetch(`/match?lat=${lat}&lon=${lon}&r=${currentRadiusMetres()}`);
  const matches = await r.json();
  lastClickLatLng = L.latLng(lat, lon);
  lastMatches = matches;
  renderMatches(matches, lastClickLatLng);
}

async function queryPolygon(wkt) {
  const fd = new FormData();
  fd.append('wkt', wkt);
  const r = await fetch('/match/polygon', { method: 'POST', body: fd });
  renderMatches(await r.json());
}

function highlightFeatures(idSet) {
  for (const [id, layer] of layersById) {
    layer.setStyle(idSet.has(id) ? STYLE_MATCH : STYLE_BASE);
    if (idSet.has(id)) layer.bringToFront();
  }
  for (const [id, layer] of casingsById) {
    layer.setStyle(idSet.has(id) ? STYLE_MATCH_CASING : STYLE_CASING);
    if (idSet.has(id)) layer.bringToFront();
  }
  // After bringing match layers to front, make sure the coloured tops are on top of their casings.
  if (idSet.size) {
    for (const id of idSet) {
      const top = layersById.get(id);
      if (top) top.bringToFront();
    }
  }
}

function typeIcon(type) {
  if (type === 'TrailRun') return '<span class="ti trail" title="Trail run">⛰️</span>';
  if (type === 'Run')      return '<span class="ti road"  title="Road run">🛣️</span>';
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
  for (const [, l] of layersById) l.unbindTooltip();
  for (const m of matches) {
    const layer = layersById.get(m.id);
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

function renderMatches(matches, atLatLng) {
  if (matchPopup) {
    const old = matchPopup;
    matchPopup = null;
    closePopupProgrammatically(old);
  }
  // Any prior preview belonged to the previous selection; drop it. The
  // single-match branch below re-opens it for the new activity; in the
  // multi-match branch it stays closed until the user clicks a title.
  hidePreview();

  highlightFeatures(new Set(matches.map(m => m.id)));
  if (clickMarker) clickMarker.bringToFront();

  // No matches: pop a brief "no runs here" and bail.
  if (!matches.length) {
    matchPopup = L.popup({
      className: 'match-popup', closeOnClick: true, autoClose: true, maxWidth: 280,
    }).setLatLng(atLatLng).setContent('<p class="muted" style="margin:4px 0">No runs here at this radius.</p>').openOn(map);
    return;
  }

  // Compute the zoom bbox regardless of branch.
  let b = null;
  for (const m of matches) {
    const layer = layersById.get(m.id);
    if (!layer) continue;
    const lb = layer.getBounds();
    b = b ? b.extend(lb) : L.latLngBounds(lb.getSouthWest(), lb.getNorthEast());
  }
  if (b) {
    b.extend(atLatLng);
    map.flyToBounds(b, { padding: [10, 10], maxZoom: 18, duration: 0.6 });
  }

  // Single match: skip the matches popup and the layer tooltip — they're
  // redundant when there's only one option. Auto-open the rich preview.
  if (matches.length === 1) {
    scheduleStravaPreview(matches[0].id, { delay: 0 });
    return;
  }

  // Multiple matches: show the matches table and rely on layer tooltips so the
  // user can identify which red line is which.
  bindMatchTooltips(matches);
  const html = `<table class="matches-table"><tbody>${matches.map(rowHtml).join('')}</tbody></table>`;
  matchPopup = L.popup({
    className: 'match-popup',
    closeOnClick: false, autoClose: false, maxWidth: 360,
  }).setLatLng(atLatLng).setContent(html).openOn(map);

  const popupEl = matchPopup.getElement();
  if (popupEl) {
    popupEl.querySelectorAll('tr[data-id]').forEach(tr => {
      const id = parseInt(tr.dataset.id, 10);
      const layer = layersById.get(id);
      const casing = casingsById.get(id);
      if (!layer) return;
      tr.addEventListener('mouseenter', () => {
        // Dim every other matched track so the hovered one stands out.
        for (const m of matches) {
          if (m.id === id) continue;
          const ol = layersById.get(m.id);
          const oc = casingsById.get(m.id);
          if (oc) oc.setStyle(STYLE_MATCH_DIM_CASING);
          if (ol) ol.setStyle(STYLE_MATCH_DIM);
        }
        if (casing) { casing.setStyle(STYLE_HOVER_CASING); casing.bringToFront(); }
        layer.setStyle(STYLE_HOVER); layer.bringToFront();
      });
      tr.addEventListener('mouseleave', () => {
        // Restore every matched track to the regular match style.
        for (const m of matches) {
          const ol = layersById.get(m.id);
          const oc = casingsById.get(m.id);
          if (oc) oc.setStyle(STYLE_MATCH_CASING);
          if (ol) ol.setStyle(STYLE_MATCH);
        }
      });
    });
    // Title click → open the rich embed preview for that activity.
    popupEl.querySelectorAll('a.open-preview').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        const id = parseInt(a.dataset.id, 10);
        scheduleStravaPreview(id, { delay: 0 });
      });
    });
  }
}

function clearMatches() {
  if (matchPopup) { map.closePopup(matchPopup); matchPopup = null; }
  lastMatches = [];
  for (const [, l] of layersById) l.unbindTooltip();
  highlightFeatures(new Set());
  hidePreview();
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
  if (!tracksLayer) return null;
  const cp = map.latLngToLayerPoint(clickLatLng);
  let best = null;
  for (const [, layer] of layersById) {
    const ll = layer.getLatLngs();
    const segs = Array.isArray(ll[0]) && Array.isArray(ll[0][0]) ? ll.flat() : (Array.isArray(ll[0]) ? ll : [ll]);
    for (const seg of segs) {
      let prev = map.latLngToLayerPoint(seg[0]);
      for (let i = 1; i < seg.length; i++) {
        const cur = map.latLngToLayerPoint(seg[i]);
        const r = pointToSegment(cp, prev, cur);
        if (!best || r.dist < best.dist) best = r;
        prev = cur;
      }
    }
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
function showSpinner() {
  _spinDepth++;
  if (_spinDepth === 1) document.getElementById('spinner').classList.remove('hidden');
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
document.getElementById('preview-close').onclick = hidePreview;

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

// Persist view across reloads (writes to the URL hash so views are shareable).
map.on('moveend', saveState);
document.addEventListener('change', e => {
  if (e.target && e.target.id === 'lock-to-track') saveState();
});

// ---- Auto-match: when only one track is in view, treat as a match -------

let autoMatchTimer = null;

function trackMidpointLatLng(layer) {
  const ll = layer.getLatLngs();
  // LineString → array of LatLng. MultiLineString / nested → flatten.
  const coords = (ll.length && ll[0] && typeof ll[0].lat === 'number') ? ll : ll.flat(Infinity);
  return coords[Math.floor(coords.length / 2)];
}

function maybeAutoMatch() {
  if (map.getZoom() < HEX_ZOOM_THRESHOLD) return;
  if (autoMatchSuppressed) return;
  if (clickMarker && autoMatchedId == null) return;
  if (!layersById.size) return;

  const view = map.getBounds();
  let only = null;
  let count = 0;
  for (const [id, layer] of layersById) {
    if (view.intersects(layer.getBounds())) {
      count++;
      if (count > 1) break;
      only = id;
    }
  }

  if (count === 1 && only != null) {
    if (autoMatchedId === only) return;
    const meta = metaById.get(only);
    if (!meta) return;
    clearClickGraphics();
    autoMatchedId = only;
    const layer = layersById.get(only);
    // Anchor on a point that's actually ON the track (~the middle vertex),
    // not the bounding-box centre which often sits off-route.
    const anchor = trackMidpointLatLng(layer);
    clickMarker = L.circleMarker(anchor, {
      radius: 6, color: '#d62728', fillOpacity: 0.9, weight: 2,
    }).addTo(map);
    renderMatches([meta], anchor);
  } else if (autoMatchedId != null) {
    autoMatchedId = null;
    clearClickGraphics();
    if (matchPopup) {
      const old = matchPopup;
      matchPopup = null;
      closePopupProgrammatically(old);
    }
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
    color: '#d62728', weight: 1, opacity: 0.5,
    fillColor: '#d62728', fillOpacity: 0.08,
  }).addTo(map);
  clickMarker = L.circleMarker(target, { radius: 5, color: '#d62728', fillOpacity: 0.9, weight: 2 }).addTo(map);
  queryPoint(target.lat, target.lng);
  // No flyTo here — renderMatches will fit-bounds to the matched tracks.
});

// Keep the search circle sized correctly if the user zooms while a click is active.
map.on('zoomend', () => {
  if (!clickMarker || !clickRadiusCircle) return;
  clickRadiusCircle.setRadius(currentRadiusMetres());
});

map.on(L.Draw.Event.CREATED, async e => {
  pushHistoryCheckpoint();
  drawnItems.clearLayers();
  drawnItems.addLayer(e.layer);
  e.layer.setStyle({ color: '#d62728', weight: 2, fill: false });
  clearClickGraphics();
  if (matchPopup) { const old = matchPopup; matchPopup = null; closePopupProgrammatically(old); }

  const latlngs = e.layer.getLatLngs()[0];
  const pts = latlngs.map(p => `${p.lng} ${p.lat}`);
  pts.push(`${latlngs[0].lng} ${latlngs[0].lat}`);
  polygonFilter = `POLYGON((${pts.join(', ')}))`;
  polygonBounds = e.layer.getBounds();
  autoMatchSuppressed = false;
  showPolygonCloseBtn();
  updateFilterBanner();

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
  status.textContent = `Uploading ${(file.size / 1e6).toFixed(1)} MB and parsing — this may take a while…`;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const r = await fetch('/import/zip', { method: 'POST', body: fd });
    if (!r.ok) throw new Error(await r.text());
    const j = await r.json();
    status.className = 'status ok';
    status.textContent = `Imported ${j.inserted} runs (skipped ${j.skipped}).`;
    await loadTracks();
    fitView();
    applyZoomMode();
    await loadStats();
  } catch (err) {
    status.className = 'status error';
    status.textContent = `Failed: ${err.message || err}`;
  }
});

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
    const fd = new FormData();
    fd.append('range', document.getElementById('sync-range').value);
    s.className = 'status'; s.textContent = 'Syncing — this may take a while if rate-limited…';
    const r = await fetch('/strava/sync', { method: 'POST', body: fd });
    if (r.ok) {
      const j = await r.json();
      s.className = 'status ok';
      s.textContent = `Synced ${j.inserted} runs (skipped ${j.skipped}).`;
      await loadTracks();
      fitView();
      applyZoomMode();
      await loadStats();
    } else {
      const t = await r.text();
      s.className = 'status error'; s.textContent = `Sync failed: ${t}`;
    }
  };
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

// Pressing the popup's × is handled by Leaflet; when popup closes, drop visuals too.
map.on('popupclose', e => {
  if (e.popup === matchPopup) {
    matchPopup = null;
    clearClickGraphics();
    clearMatches();
  }
  // If the user closed the popup (× or click-away) we suppress further
  // auto-match popups until they take a deliberate action (preset change,
  // manual click, filter change). Programmatic closes don't trigger this.
  if (!_programmaticPopupClose) {
    autoMatchSuppressed = true;
  }
  autoMatchedId = null;
});

function closePopupProgrammatically(p) {
  if (!p) return;
  _programmaticPopupClose = true;
  try { map.closePopup(p); } finally { _programmaticPopupClose = false; }
}

// ---- Library stats -------------------------------------------------------

function renderYearChart(yearly) {
  if (!yearly.length) return '';
  // Fill in missing years so gaps are visually obvious.
  const minY = yearly[0].year, maxY = yearly[yearly.length - 1].year;
  const byYear = new Map(yearly.map(y => [y.year, y.count]));
  const series = [];
  for (let y = minY; y <= maxY; y++) series.push({ year: y, count: byYear.get(y) || 0 });

  const w = 300, h = 80, pad = 18;
  const barW = (w - 4) / series.length;
  const max = Math.max(...series.map(s => s.count), 1);
  let svg = `<svg viewBox="0 0 ${w} ${h + pad}" class="year-chart" preserveAspectRatio="xMidYMid meet">`;
  series.forEach((s, i) => {
    const x = 2 + i * barW;
    const barH = (s.count / max) * h;
    const baseCls = s.count === 0 ? 'gap' : 'bar';
    const activeCls = yearFilter === s.year ? ' active' : '';
    svg += `<rect data-year="${s.year}" class="${baseCls}${activeCls}" x="${x + 1}" y="${h - barH}" width="${barW - 2}" height="${Math.max(barH, 1)}"><title>${s.year}: ${s.count}${s.count ? ' — click to filter' : ''}</title></rect>`;
    // Invisible clickzone covering the full column makes thin/zero bars easier to hit.
    svg += `<rect data-year="${s.year}" class="clickzone" x="${x}" y="0" width="${barW}" height="${h + pad}"><title>${s.year}: ${s.count}</title></rect>`;
    if (s.count) {
      svg += `<text x="${x + barW/2}" y="${h - barH - 2}" text-anchor="middle" font-size="9" fill="#444">${s.count}</text>`;
    }
    if (series.length <= 12 || i % 2 === 0) {
      svg += `<text x="${x + barW/2}" y="${h + 12}" text-anchor="middle" font-size="9" fill="#777">${s.year}</text>`;
    }
  });
  svg += '</svg>';
  return svg;
}

function bindYearChartClicks() {
  document.querySelectorAll('.year-chart [data-year]').forEach(el => {
    el.addEventListener('click', () => {
      const y = parseInt(el.dataset.year, 10);
      if (yearFilter === y) {
        clearFilter();
      } else {
        filterByYear(y);
        // No need to re-load stats — they're library-wide.
      }
    });
  });
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
  bindYearChartClicks();
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

  const prevFilterKey = JSON.stringify([currentPreset, yearFilter, polygonFilter]);

  // Reset filters from URL
  currentPreset = saved?.preset || 'all';
  yearFilter = (saved && typeof saved.yearFilter === 'number') ? saved.yearFilter : null;
  polygonFilter = saved?.polygonFilter || null;
  polygonBounds = null;
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

  const newFilterKey = JSON.stringify([currentPreset, yearFilter, polygonFilter]);
  const filterChanged = newFilterKey !== prevFilterKey;
  const haveSavedView = saved && saved.center && Array.isArray(saved.center) && saved.zoom != null;

  if (haveSavedView) {
    // Apply the saved view FIRST so we know the bbox, then load only the
    // tracks intersecting it — first paint is fast. Remaining tracks load
    // in the background so the heatmap / pan-away still works.
    map.setView(L.latLng(saved.center[0], saved.center[1]), saved.zoom, { animate });
    if (filterChanged || layersById.size === 0) {
      const b = map.getBounds();
      const bboxStr = `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
      await loadTracks({ bbox: bboxStr });
      // Background pass for everything outside the bbox — fire-and-forget.
      loadTracks({ exclude_bbox: bboxStr, append: true })
        .catch(err => console.warn('background load failed', err));
    }
  } else {
    if (filterChanged || layersById.size === 0) await loadTracks();
    fitView();
  }

  applyZoomMode();
  updateFilterBanner();

  // Re-apply polygon highlight after tracks are loaded.
  if (matchPopup) { const old = matchPopup; matchPopup = null; closePopupProgrammatically(old); }
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
  await applyURLState({ animate: false });

  if (fresh && currentPreset === 'recent90') {
    showToast('Showing runs from the last 90 days. Use the ⟲ menu to change.');
  }

  await refreshStravaUI();
  await loadStats();
  await maybeAutoOpenSettings();
  saveState();
})();
