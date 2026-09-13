// Country extents and city/capital points come from bundled Natural Earth data.
// Approximate positions never overwrite the directory's source record.
let bounds, places;
let loading;
let resolved = new WeakMap();
const fold = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .normalize('NFC').replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2').replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
  .replace(/([\p{L}\p{M}])(\p{N})/gu, '$1 $2').replace(/(\p{N})([\p{L}\p{M}])/gu, '$1 $2')
  .toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim();
const legacyFold = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
let cityIndex, countryIndex, adminIndex, legacyCityIndex, legacyCountryIndex;
let nameMatchingCountries = new Set();
// Stream-format labels are not city hints (for example "/mobile" is not Mobile, Alabama).
const streamWords = new Set(['mobile','online','web','live','stream','stereo','mono','classic','classics','jazz','rock','pop','dance',
  'radio','music','news','talk','hit','hits','fm','am','love','life','jesus','maria','faith','hope','joy','gold','golden',
  'paradise','capital','channel','station','freedom','peace','world','free','mix','remix','the','and','for','you','all',
  'one','two','top','hot','new','old','non','rap','rnb','air']);
const legacyStreamWords = new Set(['mobile','online','web','live','stream','stereo','mono','classic','classics','jazz','rock','pop','dance']);
const nativeLetter = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const nativeOnly = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}々〆ー]+$/u;
const nativeRuns = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}々〆ー]+/gu;
const compact = name => name.replace(/ /g, '');
const nativeAlias = name => nativeOnly.test(name) && [...name].filter(letter=>nativeLetter.test(letter)).length>=2;
const cityKey = city => `${city.countryCode}:${city.lat}:${city.lon}`;
const adminKey = city => city.admin1 ? `${city.countryCode}:${city.admin1.code || fold(city.admin1.name)}` : '';

function buildLegacyIndex(entries) {
  const aliases = new Map();
  let maxWords = 0;
  entries.forEach((entry,order)=>{
    const indexed = {...entry,order};
    for (const name of entry.names) {
      if (!aliases.has(name)) aliases.set(name,[]);
      aliases.get(name).push(indexed);
      maxWords = Math.max(maxWords,name.split(' ').length);
    }
  });
  return {aliases,maxWords};
}

function legacyMatches(words,index) {
  const matches = new Map();
  for (let start=0;start<words.length;start++) {
    let name = '';
    for (let end=start;end<Math.min(words.length,start+index.maxWords);end++) {
      name += (end>start?' ':'')+words[end];
      for (const entry of index.aliases.get(name) || []) matches.set(entry,Math.max(matches.get(entry)||0,name.length));
    }
  }
  return [...matches].sort(([a],[b])=>a.order-b.order).map(([entry,length])=>({...entry,length}));
}

function buildNameIndex(entries) {
  const aliases = new Map(), nativeAliases = new Map();
  let maxLength = 0, maxNativeLength = 0;
  entries.forEach((entry, order) => {
    const indexed = {...entry, order};
    for (const name of entry.names) {
      const key = compact(name), native = nativeAlias(key);
      const match = {entry:indexed, length:key.length, native, baseline:entry.baselineNames?.has(key) || false};
      if (!aliases.has(key)) aliases.set(key, []);
      aliases.get(key).push(match);
      maxLength = Math.max(maxLength, key.length);
      if (native) {
        if (!nativeAliases.has(key)) nativeAliases.set(key, []);
        nativeAliases.get(key).push(match);
        maxNativeLength = Math.max(maxNativeLength, [...key].length);
      }
    }
  });
  return {aliases, maxLength, nativeAliases, maxNativeLength};
}

function matchingNames(text, index) {
  const matches = new Map();
  const add = hits => {
    for (const {entry,length,native,baseline} of hits || []) {
      const previous = matches.get(entry);
      matches.set(entry, {length:Math.max(previous?.length || 0,length), native:native || previous?.native || false,
        baseline:(length>=(previous?.length || 0) && baseline) || ((previous?.length || 0)>=length && previous?.baseline) || false});
    }
  };
  const words = text.split(' ');
  for (let start = 0; start < words.length; start++) {
    let name = '';
    for (let end = start; end < words.length; end++) {
      name += words[end];
      if (name.length > index.maxLength) break;
      add(index.aliases.get(name));
    }
  }
  // East Asian scripts often have no spaces between the city and the station name.
  if (index.maxNativeLength) {
    for (const [run] of text.matchAll(nativeRuns)) {
      const letters = [...run];
      for (let start = 0; start < letters.length; start++) {
        let name = '';
        for (let end = start; end < Math.min(letters.length,start+index.maxNativeLength); end++) {
          name += letters[end];
          if (end > start) add(index.nativeAliases.get(name));
        }
      }
    }
  }
  // Keep gazetteer order for equal aliases, including entries sharing coordinates.
  return [...matches].sort(([a], [b]) => a.order - b.order)
    .map(([entry, match]) => ({...entry, ...match}));
}

async function readAsset(name, signal) {
  const response = await fetch(new URL('./assets/' + name, import.meta.url), {credentials:'omit', cache:'no-cache', signal});
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
      nameMatchingCountries = new Set(Array.isArray(places.nameMatchingCountries)?places.nameMatchingCountries:[]);
      const legacyCities = places.places.slice(0,Number.isInteger(places.legacyPlaceCount)?places.legacyPlaceCount:places.places.length);
      legacyCityIndex = buildLegacyIndex(legacyCities.map(city=>({city,names:[...new Set((city.legacyNames || [city.name,...(city.aliases || [])]).map(legacyFold))].filter(name=>name.length>=4&&!legacyStreamWords.has(name))})));
      legacyCountryIndex = buildLegacyIndex(Object.entries(places.countries).map(([code,country])=>({code,names:[...new Set([country.name,...(country.aliases || [])].map(legacyFold))].filter(name=>name.length>=4)})));
      cityIndex = buildNameIndex(places.places.map((city,index) => {
        const canonical = fold(city.name);
        const names = [...new Set([canonical,...(city.aliases || []).map(fold)])].filter(name=>{
          const key = compact(name);
          return !streamWords.has(key) && (nativeAlias(key) || key.length>=4 || (name===canonical && /^[a-z]{3}$/.test(key)));
        });
        const baselineNames = new Set(index<legacyCities.length?(city.legacyNames || [city.name,...(city.aliases || [])]).map(fold).map(compact):[]);
        return {city,names,baselineNames};
      }));
      countryIndex = buildNameIndex(Object.entries(places.countries).map(([code,country]) => ({code, names:[...new Set([country.name,...(country.aliases || [])].map(fold))].filter(name=>name.length>=4 || nativeAlias(compact(name)))})));
      const admins = new Map();
      for (const city of places.places) {
        if (!city.admin1) continue;
        const key = adminKey(city), admin = city.admin1;
        const suffix = String(admin.code || '').split('.').pop();
        const names = [admin.name,...(admin.aliases || []),/^[a-z]{2,3}$/i.test(suffix)?suffix:''].map(fold).filter(name=>name.length>=2);
        const entry = admins.get(key);
        if (entry) entry.names.push(...names);
        else admins.set(key,{key,countryCode:city.countryCode,names});
      }
      adminIndex = buildNameIndex([...admins.values()].map(entry=>({...entry,names:[...new Set(entry.names)]})));
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

function legacyNamedPlace(station,countryCode,localOnly=false) {
  const words = legacyFold(station.name).split(' ');
  const countries = localOnly?[]:legacyMatches(words,legacyCountryIndex);
  const explicitCountry = countries.length===1?countries[0].code:'';
  const expected = explicitCountry || countryCode;
  const matches = legacyMatches(words,legacyCityIndex);
  const local = matches.filter(match=>match.city.countryCode===expected);
  const candidates = local.length?local:localOnly || explicitCountry?[]:matches.filter(match=>match.length>=5);
  const longest = Math.max(0,...candidates.map(match=>match.length));
  const best = candidates.filter(match=>match.length===longest);
  const unique = new Map(best.map(({city})=>[cityKey(city),city]));
  return {city:unique.size===1?[...unique.values()][0]:null,countryCode:explicitCountry || countryCode};
}

function namedPlace(station, countryCode, localOnly = false) {
  // Reviewed brand/devotional words can resemble towns. Ignore only that
  // record's title; its supplied coordinates and state remain usable.
  const ignoreName = Object.hasOwn(places.stationOverrides || {}, station.id)
    && places.stationOverrides[station.id].ignoreName;
  const name = ignoreName ? '' : fold(station.name), state = fold(station.state);
  const countries = localOnly ? [] : matchingNames(name, countryIndex);
  const explicitCountry = countries.length===1 ? countries[0].code : '';
  const expected = explicitCountry || countryCode;
  const matches = matchingNames(name, cityIndex);
  const local = matches.filter(match=>match.city.countryCode===expected);
  const stateCities = state ? matchingNames(state,cityIndex).filter(match=>match.city.countryCode===expected) : [];
  // Prefer the listed country. Global matches must be unambiguous and longer
  // than a short word that could simply be part of the station's brand.
  const candidates = local.length ? local : stateCities.length ? stateCities : localOnly || explicitCountry ? [] : matches.filter(match=>match.length>=5 || match.native);
  const longest = Math.max(0,...candidates.map(match=>match.length));
  let best = candidates.filter(match=>match.length===longest);
  let unique = new Map(best.map(({city})=>[cityKey(city),city]));
  if (unique.size>1 && state) {
    const stateLengths = new Map();
    for (const match of stateCities) {
      const key = cityKey(match.city);
      stateLengths.set(key,Math.max(stateLengths.get(key) || 0,match.length));
    }
    const strongest = Math.max(0,...best.map(match=>stateLengths.get(cityKey(match.city)) || 0));
    if (strongest) best = best.filter(match=>stateLengths.get(cityKey(match.city))===strongest);
    const admins = new Set(matchingNames(state,adminIndex).filter(match=>match.countryCode===expected).map(match=>match.key));
    const inState = best.filter(match=>admins.has(adminKey(match.city)));
    if (admins.size) best = inState;
    unique = new Map(best.map(({city})=>[cityKey(city),city]));
  }
  if (unique.size>1) {
    // New small-town aliases must not erase one established city match. State
    // constraints above still take priority, and multiple established cities tie.
    const established = new Map(best.filter(match=>match.baseline).map(({city})=>[cityKey(city),city]));
    if (established.size===1) unique = established;
  }
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
  if (correction && validPoint(correction)) {
    const location = {lat:correction.lat,lon:correction.lon,countryCode:sourceCode,country:places.countries[sourceCode]?.name || station.country || sourceCode,
      city:correction.city,approximate:true,method:'reviewed'};
    resolved.set(station,location);
    return location;
  }
  if (original && fitsCountry(original, sourceCode)) {
    resolved.set(station,original);
    return original;
  }
  // Without source coordinates, a station brand cannot relocate its known country.
  const localOnly = !original && Object.hasOwn(places.countries, sourceCode);
  const hint = nameMatchingCountries.has(sourceCode)?namedPlace(station,sourceCode,localOnly):legacyNamedPlace(station,sourceCode,localOnly);
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
