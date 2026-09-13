// Source: radio-directory.js:54 - keep the existing normalized station contract.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const playableCodecs = new Set(['MP3', 'AAC', 'AAC+', 'OGG', 'OPUS']);
const source = 'Radio Dunya speech collection';
const unavailable = 'The Talk & News collection could not load. Please try again.';
let cache;
let loading;
let stationsById = new Map();
let stationsByUrl = new Map();

const clean = (value, length) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, length) : '';

// Source: radio-directory.js:44 - allow only credential-free web URLs.
function safeUrl(value, httpsOnly = false) {
  if (typeof value !== 'string' || value.length > 4096) return '';
  try {
    const url = new URL(value);
    if (!(httpsOnly ? url.protocol === 'https:' : ['https:', 'http:'].includes(url.protocol))) return '';
    if (url.username || url.password) return '';
    return url.href;
  } catch { return ''; }
}

function streamKey(value) {
  const safe = safeUrl(value, true);
  if (!safe) return '';
  const url = new URL(safe);
  // Fragments are never sent to the station. Preserve paths and queries, which
  // can select distinct channels on the same streaming host.
  url.hash = '';
  return url.href;
}

function normalize(data) {
  const timestamp = Date.parse(data?.updatedAt);
  if (data?.version !== 1 || !Number.isFinite(timestamp) || timestamp > Date.now() + 60000 ||
      !Array.isArray(data.stations) || !data.stations.length || data.stations.length > 2000) {
    throw new Error(unavailable);
  }
  const byId = new Map();
  const byUrl = new Map();
  const stations = [];
  for (const row of data.stations) {
    if (!row || typeof row !== 'object') continue;
    const id = typeof row.id === 'string' ? row.id.trim().toLowerCase() : '';
    const url = streamKey(row.url);
    const name = clean(row.name, 400);
    const codec = clean(row.codec, 24).toUpperCase();
    const talkFormat = clean(row.talkFormat, 80);
    const evidence = safeUrl(row.evidence);
    const countryCode = typeof row.countryCode === 'string' ? row.countryCode.trim().toUpperCase() : '';
    if (!uuid.test(id) || !url || !name || !playableCodecs.has(codec) || !talkFormat || !evidence || !/^[A-Z]{2}$/.test(countryCode)) continue;
    if (byId.has(id) || byUrl.has(url) || /\.m3u8$/i.test(new URL(url).pathname)) continue;
    // Source: station-location.js:98 - missing points use its city/capital fallback.
    const hasPoint = Number.isFinite(row.lat) && Number.isFinite(row.lon) && Math.abs(row.lat) <= 90 && Math.abs(row.lon) <= 180;
    // Source: radio-directory.js:74 - fields consumed by the existing globe/player.
    const station = {
      id, name, url, codec, lat: hasPoint ? row.lat : null, lon: hasPoint ? row.lon : null,
      country: clean(row.country, 100), countryCode,
      state: clean(row.state, 160), language: clean(row.language, 300), tags: clean(row.tags, 600),
      homepage: safeUrl(row.homepage), bitrate: Math.max(0, Math.min(10000, Number(row.bitrate) || 0)),
      talkFormat, evidence, discovery: safeUrl(row.discovery),
    };
    stations.push(station);
    byId.set(id, station);
    byUrl.set(url, station);
  }
  if (!stations.length) throw new Error(unavailable);
  stationsById = byId;
  stationsByUrl = byUrl;
  return { stations, updatedAt: new Date(timestamp).toISOString(), source };
}

export function loadTalkDirectory() {
  if (cache) return Promise.resolve(cache);
  if (!loading) loading = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      // Source: radio-directory.js:8 - relative URLs preserve GitHub Pages subpaths.
      const response = await fetch(new URL('./assets/talk-stations.json', import.meta.url), {
        credentials: 'omit', signal: controller.signal, redirect: 'error',
      });
      if (!response.ok) throw new Error(unavailable);
      cache = normalize(await response.json());
      return cache;
    } catch {
      throw new Error(unavailable);
    } finally { clearTimeout(timer); }
  })().finally(() => { loading = null; });
  return loading;
}

// Source: app.js:13 - saved favorites retain full station records across visits.
// Either stable identity can reconnect a saved/duplicate record to the reviewed
// collection. Community tags and station names never grant membership.
export function getTalkStation(station) {
  if (!station || typeof station !== 'object') return null;
  const id = typeof station.id === 'string' ? station.id.trim().toLowerCase() : '';
  return stationsById.get(id) || stationsByUrl.get(streamKey(station.url)) || null;
}

export function isTalkStation(station) { return Boolean(getTalkStation(station)); }
