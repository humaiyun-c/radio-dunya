// Keep directory, bundled catalog, and saved-record policy in one pure predicate.
// These are online-only, mass-programmed brand families listed under the UAE.
// The country guard keeps other regional stations using shared CDNs intact.
const uaeSyndicatedDomains = [
  'you.radio', 'exclusive.radio', 'positivity.radio', 'uber.radio',
  'ticktock.radio', 'classicalradio.com', 'classicalradio.world',
  'loveradio.love', 'starbox.radio', 'justjazz.radio', 'easy.radio',
  'greatesthits.radio', 'boomerang.radio', 'tinder.radio', 'forkids.radio',
  'countrymusicradio.world',
];
const uaeResidualNames = new Set([
  'radio relax', 'calm smooth', 'the groovy smooth jazz station',
  'sportify bollywood workout', 'tinder radio bollywood', 'oldies vibes',
  'classic rock - all the classics', 'joni mitchell 2', 'dance machine',
]);

function hostname(value) {
  if (typeof value !== 'string') return '';
  try { return new URL(value).hostname.toLowerCase(); } catch { return ''; }
}

function belongsTo(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

export function isExcludedStation(station) {
  if (!station || typeof station !== 'object') return false;
  const countryCode = String(station.countryCode ?? station.countrycode ?? '').trim().toUpperCase();
  const name = typeof station.name === 'string' ? station.name.trim() : '';
  // This Grateful Dead network channel also appears with incorrect country data.
  if (name.toLowerCase()==='gd dubai' && [station.url,station.url_resolved,station.homepage]
    .map(hostname).some(host=>belongsTo(host,'exclusive.radio')||belongsTo(host,'you.radio'))) return true;
  if (countryCode !== 'AE') return false;
  if (/\bexclusiv(?:e|ely)?\b/i.test(name) || uaeResidualNames.has(name.toLowerCase())) return true;
  return [station.url, station.url_resolved, station.homepage]
    .map(hostname).some(host => uaeSyndicatedDomains.some(domain => belongsTo(host, domain)));
}
