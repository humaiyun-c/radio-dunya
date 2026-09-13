// Keep directory, bundled catalog, and saved-record policy in one pure predicate.
export function isExcludedStation(station) {
  if (!station || typeof station !== 'object') return false;
  const countryCode = String(station.countryCode ?? station.countrycode ?? '').trim().toUpperCase();
  const name = typeof station.name === 'string' ? station.name : '';
  return countryCode === 'AE' && /\bexclusiv(?:e|ely)?\b/i.test(name);
}
