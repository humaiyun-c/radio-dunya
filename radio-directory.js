const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const mirrorName = /^[a-z0-9-]+\.api\.radio-browser\.info$/;
const fallbacks = ['de1.api.radio-browser.info', 'fi1.api.radio-browser.info'];
const maxAge = 6 * 60 * 60 * 1000;
const unavailable = 'The radio directory is temporarily unavailable. Please try again in a minute.';
const cacheName = 'radio-dunya-directory-v1';
// Scope the saved directory to this site, including GitHub Pages project paths.
const cacheUrl = new URL('./radio-directory-cache', import.meta.url).href;
let cache;
let loading;
let restored = false;
let activeMirror = fallbacks[Math.floor(Math.random() * fallbacks.length)];
let retryAfter = 0;

async function fetchJson(url, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    // Simple CORS GETs work directly in browsers. Browsers control User-Agent.
    const response = await fetch(url, {
      credentials: 'omit', signal: controller.signal, redirect: 'error',
    });
    if (!response.ok) throw new Error(`Directory returned HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

async function discoverMirrors() {
  let names = [];
  // Official browser bootstrap and randomized retries: https://api.radio-browser.info/
  try {
    const servers = await fetchJson('https://all.api.radio-browser.info/json/servers', 5000);
    if (Array.isArray(servers)) names = servers.map(server => server?.name);
  } catch { /* Known mirrors keep startup usable during discovery outages. */ }
  names = [...new Set([...names.filter(name => typeof name === 'string' && mirrorName.test(name)), ...fallbacks])];
  for (let i = names.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [names[i], names[j]] = [names[j], names[i]];
  }
  return names.slice(0, 3);
}

const clean = (value, length = 240) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, length) : '';
function safeUrl(value, httpsOnly = false) {
  if (typeof value !== 'string' || value.length > 4096) return '';
  try {
    const url = new URL(value);
    if (!(httpsOnly ? url.protocol === 'https:' : ['https:', 'http:'].includes(url.protocol))) return '';
    if (url.username || url.password) return '';
    return url.href;
  } catch { return ''; }
}

function normalize(rows) {
  if (!Array.isArray(rows)) throw new Error('Directory response was not a station list.');
  const seenIds = new Set();
  const seenUrls = new Set();
  const stations = [];
  // Fields and native stream selection: https://docs.radio-browser.info/#station
  for (const row of rows.slice(0, 10000)) {
    if (!row || typeof row !== 'object') continue;
    const id = clean(row.stationuuid, 36).toLowerCase();
    const url = safeUrl(row.url_resolved || row.url, true);
    const name = clean(row.name, 400);
    const codec = clean(row.codec, 24).toUpperCase();
    if (!uuid.test(id) || !name || !url || seenIds.has(id) || seenUrls.has(url)) continue;
    if (Number(row.hls) !== 0 || Number(row.lastcheckok) !== 1 || !['MP3', 'AAC', 'AAC+', 'OGG', 'OPUS'].includes(codec)) continue;
    if (row.geo_lat == null || row.geo_long == null || row.geo_lat === '' || row.geo_long === '') continue;
    const lat = Number(row.geo_lat);
    const lon = Number(row.geo_long);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    seenIds.add(id);
    seenUrls.add(url);
    stations.push({
      id, name, url, codec, lat, lon,
      country: clean(row.country, 100), countryCode: clean(row.countrycode, 2).toUpperCase(),
      state: clean(row.state, 160), language: clean(row.language, 300), tags: clean(row.tags, 600),
      homepage: safeUrl(row.homepage), bitrate: Math.max(0, Math.min(10000, Number(row.bitrate) || 0)),
    });
  }
  if (!stations.length) throw new Error('Directory contained no playable mapped stations.');
  return stations;
}

async function readSavedDirectory() {
  try {
    // Optional asynchronous storage, available on HTTPS/localhost without a service worker:
    // https://developer.mozilla.org/en-US/docs/Web/API/CacheStorage
    if (!globalThis.caches) return;
    const saved = await (await (await caches.open(cacheName)).match(cacheUrl))?.json();
    const timestamp = Date.parse(saved?.fetchedAt);
    if (saved?.version !== 1 || !Number.isFinite(timestamp) || timestamp > Date.now() + 60000 || !Array.isArray(saved.stations)) return;
    // Treat disk data like network data: validate URLs, IDs, coordinates, and text again.
    const stations = normalize(saved.stations.slice(0, 10000).map(station => ({
      stationuuid: station?.id, url: station?.url, name: station?.name,
      codec: station?.codec, geo_lat: station?.lat, geo_long: station?.lon,
      country: station?.country, countrycode: station?.countryCode,
      state: station?.state, language: station?.language, tags: station?.tags,
      homepage: station?.homepage, bitrate: station?.bitrate, hls: 0, lastcheckok: 1,
    })));
    return {
      stations, fetchedAt: new Date(timestamp).toISOString(), source: 'Radio Browser',
      mirror: typeof saved.mirror === 'string' && mirrorName.test(saved.mirror) ? saved.mirror : activeMirror,
    };
  } catch { /* Disabled storage, malformed records, and quota failures never stop listening. */ }
}

async function restoreDirectory() {
  let timer;
  try {
    // Disk access is optional, so do not let a stalled storage service delay startup.
    const saved = await Promise.race([
      readSavedDirectory(), new Promise(resolve => { timer = setTimeout(resolve, 1500); }),
    ]);
    if (saved) {
      activeMirror = saved.mirror;
      cache = { stations: saved.stations, fetchedAt: saved.fetchedAt, source: saved.source };
    }
  } finally { clearTimeout(timer); }
}

async function saveDirectory() {
  try {
    if (!globalThis.caches) return;
    const response = new Response(JSON.stringify({ ...cache, version: 1, mirror: activeMirror }), {
      headers: { 'Content-Type': 'application/json' },
    });
    await (await caches.open(cacheName)).put(cacheUrl, response);
  } catch { /* Memory caching still works when persistent storage is unavailable or full. */ }
}

async function refreshStations() {
  // Search parameters: https://docs.radio-browser.info/#advanced-station-search
  const path = '/json/stations/search?hidebroken=true&has_geo_info=true&is_https=true&order=clickcount&reverse=true&limit=10000';
  for (const mirror of await discoverMirrors()) {
    try {
      const stations = normalize(await fetchJson(`https://${mirror}${path}`));
      activeMirror = mirror;
      cache = { stations, fetchedAt: new Date().toISOString(), source: 'Radio Browser' };
      retryAfter = 0;
      void saveDirectory();
      return { ...cache, stale: false };
    } catch { /* Try the next directory mirror, up to three bounded requests. */ }
  }
  retryAfter = Date.now() + 60000;
  if (cache) return { ...cache, stale: true };
  throw new Error(unavailable);
}

export function getStations() {
  if (cache && Date.now() - Date.parse(cache.fetchedAt) < maxAge) return Promise.resolve({ ...cache, stale: false });
  if (Date.now() < retryAfter) return cache ? Promise.resolve({ ...cache, stale: true }) : Promise.reject(new Error(unavailable));
  if (!loading) loading = (async () => {
    if (!restored) {
      restored = true;
      await restoreDirectory();
      if (cache && Date.now() - Date.parse(cache.fetchedAt) < maxAge) return { ...cache, stale: false };
    }
    return refreshStations();
  })().finally(() => { loading = null; });
  return loading;
}

export async function recordStationClick(id) {
  if (typeof id !== 'string' || !uuid.test(id)) return false;
  try {
    // Playback notification contract: https://docs.radio-browser.info/#station-click-counter
    // Saved favorites can start playing even before the current directory loads.
    const result = await fetchJson(`https://${activeMirror}/json/url/${id.toLowerCase()}`, 5000);
    return result?.ok === true || result?.ok === 'true';
  } catch { return false; }
}
