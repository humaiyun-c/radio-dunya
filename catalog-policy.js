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

// Verified finite files: anthems, public uploads, jingles, podcast episodes,
// lectures and on-demand assets. Keep rules scoped to the provider and path.
const recordingPaths = [
  ['nationalanthems.info', /^\/[a-z]{2}\.mp3$/i],
  ['base44.app', /^\/api\/apps\/[^/]+\/files\/mp\/public\//i],
  ['uploadkon.ir', /^\/uploads\/[^/]+\.mp3$/i],
  ['downloads.manoramaonline.com', /^\/Audios\/Radiomango\/Main-jingle\.mp3$/i],
  ['ondemand-mp3.dradio.de', /^\/file\//i],
  ['tunein-ondemand.cdnstream1.com', /^\/.+\.mp3$/i],
  ['api.spreaker.com', /^\/v2\/episodes\/\d+\/play\.mp3$/i],
  ['al-badr.net', /^\/download\//i],
  ['static.s123-cdn-static-c.com', /^\/uploads\/.*\.mp3$/i],
  ['lite878.com', /^\/wp-content\/uploads\/.*\.mp3$/i],
];

function hostname(value) {
  if (typeof value !== 'string') return '';
  try { return new URL(value).hostname.toLowerCase(); } catch { return ''; }
}

function belongsTo(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function isRecordingUrl(value) {
  if (typeof value !== 'string') return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  // Archive item/download URLs serve finite recordings, including the Australian
  // forest-sound collection: https://archive.org/details/australian-forest-sounds
  // Test the audio URL, not the homepage: a broadcaster may link to its archive.
  if (belongsTo(host, 'archive.org') && /^\/(?:download|serve|(?:\d+\/)?items)\/[^/]+\/.+\.(?:mp3|m4a|wav|aac|ogg|oga|opus|flac)$/i.test(path)) return true;
  return recordingPaths.some(([domain, pattern]) => belongsTo(host, domain) && pattern.test(path));
}

export function isExcludedStation(station) {
  if (!station || typeof station !== 'object') return false;
  // A playable MP3 can be a recording. Match verified on-demand endpoints;
  // .mp3 alone is not a signal, since genuine live Icecast streams use it too.
  if ([station.url, station.url_resolved].some(isRecordingUrl)) return true;
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
