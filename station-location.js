// Country extents and city/capital points come from bundled Natural Earth data.
// Approximate positions never overwrite the directory's source record.
let bounds, places;
let loading;
let resolved = new WeakMap();
const fold = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
let cityNames = [], countryNames = [];
// Stream-format labels are not city hints (for example "/mobile" is not Mobile, Alabama).
const streamWords = new Set(['mobile','online','web','live','stream','stereo','mono','classic','classics','jazz','rock','pop','dance']);

async function readAsset(name, signal) {
  const response = await fetch(new URL('./assets/' + name, import.meta.url), {credentials:'omit', signal});
  if (!response.ok) throw new Error('Location data unavailable');
  const data = await response.json();
  if (data.version !== 1 || !data.countries || Object.keys(data.countries).length < 150) throw new Error('Invalid location data');
  return data;
}

export function loadLocationBounds() {
  if (bounds && places) return Promise.resolve(true);
  if (!loading) loading = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const [extents, gazetteer] = await Promise.all([
        readAsset('country-bounds.json', controller.signal),
        readAsset('station-places.json', controller.signal),
      ]);
      if (!Array.isArray(gazetteer.places)) throw new Error('Invalid city data');
      bounds = extents.countries;
      places = gazetteer;
      cityNames = places.places.map(city => ({city, names:[...new Set([city.name,...(city.aliases || [])].map(fold))].filter(name=>name.length>=4&&!streamWords.has(name))}));
      countryNames = Object.entries(places.countries).map(([code,country]) => ({code, names:[...new Set([country.name,...(country.aliases || [])].map(fold))].filter(name=>name.length>=4)}));
      resolved = new WeakMap();
      return true;
    } catch {
      // Keep the original pins, search, and audio if a local asset is unavailable.
      return false;
    } finally { clearTimeout(timer); }
  })().finally(() => { loading = null; });
  return loading;
}

function validPoint(point) {
  return point && Number.isFinite(point.lat) && Number.isFinite(point.lon)
    && Math.abs(point.lat)<=90 && Math.abs(point.lon)<=180;
}

function fitsCountry(point, code) {
  if (!validPoint(point)) return false;
  const regions = bounds && Object.hasOwn(bounds, code) ? bounds[code] : null;
  if (!regions) return true; // Missing country geometry is not evidence of an error.
  // Rectangles already include 50 km for coasts/borders, including date-line splits.
  return regions.some(([west,south,east,north]) => point.lat>=south && point.lat<=north
    && [point.lon,point.lon-360,point.lon+360].some(lon=>lon>=west && lon<=east));
}

function namedPlace(station, countryCode) {
  const text = ' ' + fold(station.name) + ' ';
  const contains = name => text.includes(' ' + name + ' ');
  const countries = countryNames.filter(country=>country.names.some(contains));
  const explicitCountry = countries.length===1 ? countries[0].code : '';
  const expected = explicitCountry || countryCode;
  const matches = cityNames.map(({city,names})=>({city, length:Math.max(0,...names.filter(contains).map(name=>name.length))})).filter(match=>match.length);
  const local = matches.filter(match=>match.city.countryCode===expected);
  // Prefer the listed country. Global matches must be unambiguous and longer
  // than a short word that could simply be part of the station's brand.
  const candidates = local.length ? local : explicitCountry ? [] : matches.filter(match=>match.length>=5);
  const longest = Math.max(0,...candidates.map(match=>match.length));
  const best = candidates.filter(match=>match.length===longest);
  const unique = new Map(best.map(({city})=>[city.countryCode+':'+city.lat+':'+city.lon,city]));
  return {city:unique.size===1 ? [...unique.values()][0] : null, countryCode:explicitCountry || countryCode};
}

export function getMapLocation(station) {
  if (!station || typeof station !== 'object') return null;
  if (resolved.has(station)) return resolved.get(station);
  const suppliedCode = String(station.countryCode || '').toUpperCase();
  const correction = places?.stationOverrides && Object.hasOwn(places.stationOverrides,station.id) ? places.stationOverrides[station.id] : null;
  const sourceCode = correction?.countryCode || suppliedCode;
  const original = validPoint(station) ? {lat:station.lat,lon:station.lon,countryCode:sourceCode,country:correction?places.countries[sourceCode]?.name:station.country,approximate:false,method:'source'} : null;
  // Recheck early saved favorites once the location data arrives.
  if (!bounds || !places) return original;
  if (original && fitsCountry(original, sourceCode)) {
    resolved.set(station,original);
    return original;
  }
  const hint = namedPlace(station,sourceCode);
  const code = hint.city?.countryCode || hint.countryCode;
  const country = Object.hasOwn(places.countries,code) ? places.countries[code] : null;
  let location;
  if (original && code!==sourceCode && fitsCountry(original,code)) {
    // A clear name can reveal a wrong country label while the coordinates
    // already fit the corrected country.
    location = {...original,countryCode:code,country:country?.name || code,city:hint.city?.name,approximate:true,method:'country'};
  } else {
    const point = hint.city || country?.capital;
    location = validPoint(point) ? {
      lat:point.lat,lon:point.lon,countryCode:code,country:country?.name || station.country || code,
      city:point.name,approximate:true,method:hint.city?'city':'capital',
    } : original;
  }
  resolved.set(station,location);
  return location;
}

export const isMappable = station => Boolean(getMapLocation(station));
