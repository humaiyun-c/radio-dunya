import { createGlobe } from './globe.js?v=place-names-1';
import { getStations, recordStationClick, loadRegionalDirectory } from './radio-directory.js?v=place-names-1';
import { loadLocationBounds, getMapLocation, isMappable } from './station-location.js?v=place-names-1';
import { loadTalkDirectory, getTalkStation, isTalkStation } from './talk-directory.js';

const $ = (id) => document.getElementById(id);
const audio = $('audio');
const storeKey = 'radio-dunya-v1';
const validUrl = (value) => { try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) ? u.href : ''; } catch { return ''; } };
const validStation = (s) => s && typeof s.id === 'string' && typeof s.name === 'string' && validUrl(s.url).startsWith('https:');
const fold = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
let saved = {};
try { saved = JSON.parse(localStorage.getItem(storeKey) || '{}') || {}; } catch { /* Browser storage can be disabled. */ }
let favorites = new Map((Array.isArray(saved.favorites) ? saved.favorites : []).filter(validStation).map(s => [s.id, s]));
let recent = (Array.isArray(saved.recent) ? saved.recent : []).filter(validStation).slice(0, 30);
let stations = [], filtered = [], current = null, tab = 'explore', loading = true, loadError = false;
let talkError = false, talkCount = 0, communityDirectory = null;
let regionalStations = [], regionalError = false, placeScope = null, pinGroups = new Map();
let visibleCount = 60, near = null, center = {lat:20,lon:15}, phase = 'idle';
let playGeneration = 0, connectTimer, noticeTimer, directoryGeneration = 0;
const searchIndex = new Map();
const stationDrawer = $('station-drawer');
function openStations() {
  if (!stationDrawer.open) stationDrawer.showModal();
  $('stations-open').setAttribute('aria-expanded','true');
}
function closeStations() { if (stationDrawer.open) stationDrawer.close(); }
stationDrawer.addEventListener('close',()=>{
  $('stations-open').setAttribute('aria-expanded','false');
  if(placeScope){placeScope=null;render();}
});
$('stations-open').addEventListener('click',openStations);
$('stations-close').addEventListener('click',closeStations);
stationDrawer.addEventListener('click',event=>{
  if(event.target!==stationDrawer) return;
  const bounds=stationDrawer.getBoundingClientRect();
  if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom) closeStations();
});
function setImmersive(active) {
  document.body.classList.toggle('immersive',active);
  $('fullscreen-toggle').setAttribute('aria-pressed',String(active));
  $('fullscreen-toggle').setAttribute('aria-label',active?'Restore view':'Expand globe');
  $('fullscreen-toggle').title=active?'Restore view':'Expand globe';
  $('fullscreen-icon').setAttribute('href',active?'#i-contract':'#i-expand');
}
$('fullscreen-toggle').addEventListener('click',async()=>{
  if(document.body.classList.contains('immersive')) {
    setImmersive(false);
    if(document.fullscreenElement) { try {await document.exitFullscreen();} catch {} }
  } else {
    setImmersive(true);
    // Native fullscreen is optional; the expanded layout also works on iPhone browsers.
    if(document.fullscreenEnabled && document.documentElement.requestFullscreen) {
      try {await document.documentElement.requestFullscreen();} catch { /* Keep the expanded viewport. */ }
    }
  }
});
document.addEventListener('fullscreenchange',()=>setImmersive(Boolean(document.fullscreenElement)));
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&!stationDrawer.open&&!$('about-dialog').open&&!document.fullscreenElement) setImmersive(false);
});

function persist() {
  try { localStorage.setItem(storeKey, JSON.stringify({favorites:[...favorites.values()], recent, volume:audio.volume})); }
  catch { showNotice('Browser storage is unavailable. Favorites will last for this visit.'); }
}
function showNotice(message) {
  $('notice').textContent = message;
  $('notice').hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 5500);
}
function svg(name) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  element.setAttribute('class','icon'); element.setAttribute('aria-hidden','true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href',`#i-${name}`); element.append(use); return element;
}
function locationLabel(s) {
  const location = getMapLocation(s);
  if (location?.approximate) return [location.city,location.country].filter(Boolean).join(', ');
  if (location?.countryCode && location.countryCode!==s.countryCode) return [s.state,location.country].filter(Boolean).join(', ');
  return [s.state && fold(s.state) !== fold(s.country) ? s.state : '', s.country || s.countryCode].filter(Boolean).join(', ');
}
function mapLocationNote(s) {
  return getMapLocation(s)?.approximate ? 'Approximate location' : '';
}
const countryCodeFor = s => getMapLocation(s)?.countryCode || s.countryCode;
function locationKey(s) {
  const location=getMapLocation(s);
  return location?`${location.lat},${location.lon}`:'';
}
function textFor(s) {
  if (!searchIndex.has(s.id)) searchIndex.set(s.id, fold([s.name,s.country,s.countryCode,s.state,s.language,s.tags,locationLabel(s),countryCodeFor(s)].join(' ')));
  return searchIndex.get(s.id);
}
function distance(s, origin) {
  const location = getMapLocation(s);
  if (!location) return Infinity;
  const rad = Math.PI / 180;
  return 1 - (Math.sin(location.lat*rad)*Math.sin(origin.lat*rad) + Math.cos(location.lat*rad)*Math.cos(origin.lat*rad)*Math.cos((location.lon-origin.lon)*rad));
}
const globe = createGlobe($('globe'), {
  onSelect: (station) => {
    const key=locationKey(station), group=pinGroups.get(key);
    if (group?.length>1) {
      placeScope={key,label:locationLabel(station)};
      visibleCount=60;render();openStations();$('collection').scrollTop=0;
    } else playStation(station);
  },
  onViewChange: (view) => {
    center = view;
    $('coordinates').textContent = `${Math.abs(view.lat).toFixed(0)}° ${view.lat<0?'S':'N'}, ${Math.abs(view.lon).toFixed(0)}° ${view.lon<0?'W':'E'}`;
    const zoomLevel=$('zoom-level');
    if (zoomLevel) {
      zoomLevel.textContent=`${view.zoom<10?Number(view.zoom.toFixed(1)):Math.round(view.zoom)}×`;
      zoomLevel.setAttribute('aria-label',`Zoom ${view.zoom.toFixed(1)} times, maximum ${view.maxZoom} times`);
    }
  },
  onHover: (station) => {
    $('globe-tooltip').hidden = !station;
    if (station) {
      const count=pinGroups.get(locationKey(station))?.length||1;
      $('globe-tooltip').textContent = [count>1?`${count} stations`:station.name,locationLabel(station),mapLocationNote(station)].filter(Boolean).join(' — ');
    }
  }
});
$('globe').addEventListener('globeerror', () => showNotice('The map could not load. You can still listen using the station list.'));

function updateFavoriteButtons() {
  $('favorite-count').textContent = favorites.size;
  const isFavorite = current && favorites.has(current.id);
  $('player-favorite').disabled = !current;
  $('player-favorite').setAttribute('aria-pressed',String(Boolean(isFavorite)));
  $('player-favorite').setAttribute('aria-label',isFavorite ? 'Remove station from favorites' : 'Save station to favorites');
  document.querySelectorAll('.row-favorite').forEach(button => {
    const on = favorites.has(button.dataset.id);
    button.setAttribute('aria-pressed',String(on));
    button.setAttribute('aria-label',`${on?'Remove':'Save'} ${button.dataset.name} ${on?'from':'to'} favorites`);
  });
}
function toggleFavorite(s) {
  if (!s) return;
  if (favorites.has(s.id)) favorites.delete(s.id); else favorites.set(s.id,s);
  persist();
  if (tab==='favorites') render(); else updateFavoriteButtons();
}
function setTab(next) {
  tab = next; visibleCount = 60; placeScope=null;
  document.querySelectorAll('[data-tab]').forEach(button => {
    const active = button.dataset.tab === tab;
    button.classList.toggle('active',active); button.setAttribute('aria-selected',String(active)); button.tabIndex = active ? 0 : -1;
  });
  $('collection').setAttribute('aria-labelledby',`tab-${tab}`);
  render();
  $('collection').scrollTop=0;
}
function row(s) {
  const element = document.createElement('div'); element.className = `station-row${current?.id===s.id?' selected':''}`; element.dataset.id=s.id;
  const tune = document.createElement('button'); tune.className='station-tune'; tune.type='button'; tune.setAttribute('aria-label',`Listen to ${s.name}, ${locationLabel(s)}`);
  const badge = document.createElement('span'); badge.className='station-badge'; badge.textContent=countryCodeFor(s)||'FM'; badge.setAttribute('aria-hidden','true');
  const copy = document.createElement('span'); copy.className='station-copy';
  const name = document.createElement('span'); name.className='station-name'; name.textContent=s.name;
  const meta = document.createElement('span'); meta.className='station-meta'; meta.textContent=[locationLabel(s)||s.language||'Live radio',getTalkStation(s)?.talkFormat,mapLocationNote(s)].filter(Boolean).join(' · ');
  copy.append(name,meta); tune.append(badge,copy);
  tune.addEventListener('click',() => { globe.focusStation(s); playStation(s); closeStations(); });
  const favorite = document.createElement('button'); favorite.type='button'; favorite.className='row-favorite'; favorite.dataset.id=s.id; favorite.dataset.name=s.name; favorite.append(svg('heart'));
  favorite.addEventListener('click',() => toggleFavorite(s));
  element.append(tune,favorite); return element;
}
function renderRows() {
  const list = $('station-list'); list.replaceChildren(...filtered.slice(0,visibleCount).map(row));
  $('show-more').hidden=filtered.length<=visibleCount;
  updateFavoriteButtons();
}
function render() {
  const terms = fold($('search').value).trim().split(/\s+/).filter(Boolean);
  const country = $('country').value, genre=fold($('genre').value);
  const records = tab==='favorites' ? [...favorites.values()] : tab==='recent' ? recent : stations;
  // A saved UUID can outlive its old stream; always use the reviewed record once available.
  const source = [...new Map(records.map(s=>{const reviewed=getTalkStation(s)||s;return [reviewed.id,reviewed];})).values()];
  const talk = genre==='talk';
  filtered=source.filter(s => (!country||countryCodeFor(s)===country) && (!genre||(talk ? isTalkStation(s) : fold(s.tags).includes(genre))) && terms.every(term=>textFor(s).includes(term)));
  if(placeScope) filtered=filtered.filter(s=>locationKey(s)===placeScope.key);
  pinGroups=new Map();
  for(const s of filtered){const key=locationKey(s);if(!key)continue;if(!pinGroups.has(key))pinGroups.set(key,[]);pinGroups.get(key).push(s);}
  $('map-summary').textContent=filtered.length?`${filtered.length.toLocaleString()} stations at ${pinGroups.size.toLocaleString()} map ${pinGroups.size===1?'location':'locations'}. Numbers on the map show stations sharing a location.`:'';
  $('map-summary').hidden=!filtered.length;
  if (near&&tab==='explore') filtered.sort((a,b)=>distance(a,near)-distance(b,near));
  $('list-title').textContent = placeScope ? `Stations in ${placeScope.label}` : tab==='favorites' ? 'Your favorite stations' : tab==='recent' ? 'Recently heard' : near ? 'Around this view' : talk ? 'Voices around the world' : 'Across the dial';
  $('talk-note').hidden=!talk||!talkCount;
  $('result-count').textContent=filtered.length ? filtered.length.toLocaleString() : '';
  $('clear-filters').hidden=!(terms.length||country||genre||near||placeScope);
  const status=$('directory-status');
  let message='';
  if (talk&&loading&&!talkCount) message='Loading the speech collection…';
  else if (talk&&talkError) message='The speech collection could not load. Try again.';
  else if (tab==='explore'&&loading&&!stations.length) message='Finding stations around the world…';
  else if (tab==='explore'&&loadError&&!stations.length) message='The station directory is unavailable. Try again, or listen to a saved favorite.';
  else if (!filtered.length) message=terms.length||country||genre ? 'No stations match these filters. Try another search or reset the filters.' : tab==='favorites' ? 'Keep a little of the world. Tap a heart to save a station here.' : tab==='recent' ? 'Your last 30 stations will appear here after you listen.' : 'No playable stations were returned. Try the directory again.';
  status.textContent=message; status.hidden=!message;
  $('retry-directory').hidden=!(!loading&&((talk&&talkError)||(tab==='explore'&&(loadError||regionalError))));
  $('surprise').disabled=$('next-station').disabled=!filtered.length;
  globe.setStations(filtered); renderRows();
}
function applyDirectory(data, reviewed) {
    talkCount=reviewed.length;
    // Reviewed records supply the chosen stream, including stations missing geo data.
    // Keep the global directory usable if this independent collection fails, and vice versa.
    const merged=new Map(reviewed.map(s=>[s.id,s]));
    const urls=new Set(reviewed.map(s=>s.url));
    const stableStreams=new Map(regionalStations.filter(s=>s.streamOverride).map(s=>[s.id,s.url]));
    const reviewedNames=new Map(regionalStations.filter(s=>s.nameOverride).map(s=>[s.id,s.name]));
    for (const record of [...(data?.stations||[]),...regionalStations]) {
      const stableUrl=stableStreams.get(record.id);
      const reviewedName=reviewedNames.get(record.id);
      const s=stableUrl&&record.url!==stableUrl||reviewedName&&record.name!==reviewedName?{...record,url:stableUrl||record.url,name:reviewedName||record.name}:record;
      if (!validStation(s)||merged.has(s.id)||getTalkStation(s)) continue;
      const url=new URL(s.url); url.hash='';
      if (urls.has(url.href)) continue;
      merged.set(s.id,s); urls.add(url.href);
    }
    stations=[...merged.values()]; searchIndex.clear();
    const countries=new Map(); stations.forEach(s=>{const code=countryCodeFor(s);if(code) countries.set(code,getMapLocation(s)?.country||s.country||code);});
    const previousCountry=$('country').value;
    $('country').replaceChildren(new Option('Every country',''),...[...countries.entries()].sort((a,b)=>a[1].localeCompare(b[1])).map(([value,label])=>new Option(label,value)));
    $('country').value=previousCountry;
    const currentRecords=new Map(stations.map(s=>[s.id,s]));
    const refreshed=s=>getTalkStation(s)||currentRecords.get(s.id)||s;
    favorites=new Map([...favorites.values()].map(s=>{const updated=refreshed(s);return [updated.id,updated];}));
    recent=[...new Map(recent.map(s=>{const updated=refreshed(s);return [updated.id,updated];})).values()];
    if (current) {
      const updated=refreshed(current);
      // Do not relabel audio already playing from a different saved stream.
      if (!audio.getAttribute('src')||current.url===updated.url) current=updated;
    }
    const mappedCount=stations.filter(isMappable).length;
    $('catalog-count').textContent=`${mappedCount.toLocaleString()} mapped · ${stations.length.toLocaleString()} stations${data?.stale?' (cached)':''}${loadError?' · Bundled stations only':''}`;
    if(current){globe.selectStation(current);updatePlayingMetadata();}
    render();
}
async function loadDirectory() {
  const generation=++directoryGeneration; loading=true; loadError=false; talkError=false; regionalError=false; render();
  try {
    const directoryRequest=getStations(), locationRequest=loadLocationBounds(), speechRequest=loadTalkDirectory(), regionalRequest=loadRegionalDirectory();
    // Bundled collections remain available if community mirrors are slow or blocked.
    const earlyCollections=Promise.allSettled([locationRequest,speechRequest,regionalRequest]).then(([,speech,regional])=>{
      if(generation!==directoryGeneration) return;
      if(regional.status==='fulfilled')regionalStations=regional.value.stations;
      applyDirectory(communityDirectory,speech.status==='fulfilled'?speech.value.stations:[]);
    });
    const [directory, locations, speech, regional]=await Promise.allSettled([directoryRequest,locationRequest,speechRequest,regionalRequest]);
    await earlyCollections;
    if (generation!==directoryGeneration) return;
    const data=directory.status==='fulfilled'?directory.value:null;
    loadError=!Array.isArray(data?.stations);
    if (!loadError) communityDirectory=data;
    talkError=speech.status==='rejected';
    regionalError=regional.status==='rejected';
    applyDirectory(communityDirectory,talkError?[]:speech.value.stations);
    if (!(locations.status==='fulfilled'&&locations.value)) showNotice('Location corrections could not load. Showing the directory’s original pins.');
    else if(regionalError) showNotice('Extra stations for Africa and Asia could not load. Open Stations and try again.');
  } catch {
    if (generation!==directoryGeneration) return;
    loadError=true; $('catalog-count').textContent='Station directory unavailable';
  } finally { if(generation===directoryGeneration){
    loading=false; searchIndex.clear();
    if(current){globe.selectStation(current);updatePlayingMetadata();}
    render();
  } }
}
function setPhase(next,message) {
  phase=next;
  $('play-state').textContent=message||({idle:'Ready when you are',connecting:'Connecting…',playing:'Live radio',paused:'Paused',error:'Unable to connect'}[phase]);
  $('play-indicator').className=`status-dot ${phase==='playing'?'live':phase==='connecting'?'connecting':phase==='error'?'error':''}`;
  const active=phase==='playing'||phase==='connecting';
  $('play-toggle').setAttribute('aria-label',active?'Pause':'Play');
  $('play-icon').setAttribute('href',active?'#i-pause':'#i-play');
  if('mediaSession' in navigator) navigator.mediaSession.playbackState=phase==='playing'?'playing':current?'paused':'none';
}
function disconnect() {
  clearTimeout(connectTimer); playGeneration++;
  audio.pause(); audio.removeAttribute('src'); audio.load();
}
function pause() { disconnect(); if(current) setPhase('paused'); }
function playbackError(message='This station could not connect. Try another station or press play to retry.') {
  disconnect(); setPhase('error'); showNotice(message);
}
function startWatchdog(generation) {
  clearTimeout(connectTimer);
  connectTimer=setTimeout(()=>{if(generation===playGeneration) playbackError('This station is taking too long to connect. Try another, or press play to retry.');},20000);
}
function updatePlayingMetadata() {
  const s=current;
  $('playing-name').textContent=s.name;
  $('playing-name').title=s.name;
  $('playing-location').textContent=[locationLabel(s),mapLocationNote(s),s.codec,s.bitrate?`${s.bitrate} kbps`:''].filter(Boolean).join(' · ');
  if('mediaSession' in navigator&&'MediaMetadata' in window) {
    navigator.mediaSession.metadata=new MediaMetadata({title:s.name,artist:locationLabel(s),album:'Radio Dunya'});
  }
}
function playStation(s) {
  s=getTalkStation(s)||stations.find(record=>record.id===s?.id)||s;
  if (!validStation(s)) return;
  if(current?.id===s.id&&current.url===s.url&&phase==='playing') return;
  disconnect(); const generation=playGeneration;
  current=s; setPhase('connecting');
  updatePlayingMetadata();
  $('play-toggle').disabled=false;
  const homepage=validUrl(s.homepage);
  $('station-website').hidden=!homepage;
  if(homepage) $('station-website').href=homepage; else $('station-website').removeAttribute('href');
  globe.selectStation(s); updateFavoriteButtons();
  document.querySelectorAll('.station-row').forEach(el=>el.classList.toggle('selected',el.dataset.id===s.id));
  audio.src=s.url;
  audio.play().catch(error=>{
    if(generation!==playGeneration) return;
    playbackError(error.name==='NotAllowedError'?'Your browser needs another tap on Play to start audio.':undefined);
  });
  startWatchdog(generation);
}
let lastCounted='';
audio.addEventListener('playing',()=>{
  if(!current||!audio.getAttribute('src')||audio.paused) return;
  clearTimeout(connectTimer); setPhase('playing');
  recent=[current,...recent.filter(s=>s.id!==current.id)].slice(0,30); persist();
  if(tab==='recent') render();
  if(lastCounted!==current.id){lastCounted=current.id;recordStationClick(current.id).catch(()=>{});}
});
audio.addEventListener('waiting',()=>{if(current&&audio.getAttribute('src')&&!audio.paused){setPhase('connecting','Buffering…');startWatchdog(playGeneration);}});
audio.addEventListener('error',()=>{if(current&&audio.getAttribute('src')) playbackError();});
audio.addEventListener('ended',()=>{if(current&&audio.getAttribute('src')) playbackError('The station ended its stream. Press play to reconnect.');});
function surprise() {
  const choices=filtered.filter(s=>s.id!==current?.id);
  const pick=(choices.length?choices:filtered);
  if(!pick.length) return;
  const station=pick[Math.floor(Math.random()*pick.length)];
  globe.focusStation(station); playStation(station);
}
document.querySelectorAll('[data-tab]').forEach(button=>{
  button.addEventListener('click',()=>setTab(button.dataset.tab));
  button.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault(); const names=['explore','favorites','recent'];
    const index=event.key==='Home'?0:event.key==='End'?2:(names.indexOf(tab)+(event.key==='ArrowRight'?1:2))%3;
    setTab(names[index]); $(`tab-${names[index]}`).focus();
  });
});
let searchTimer;
function refreshResults() {visibleCount=60;render();$('collection').scrollTop=0;}
$('search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(refreshResults,100);});
['country','genre'].forEach(id=>$(id).addEventListener('change',()=>{placeScope=null;refreshResults();}));
$('clear-filters').addEventListener('click',()=>{$('search').value='';$('country').value='';$('genre').value='';near=null;placeScope=null;refreshResults();});
$('show-more').addEventListener('click',()=>{visibleCount+=60;renderRows();});
$('retry-directory').addEventListener('click',loadDirectory);
$('explore-here').addEventListener('click',()=>{near={...center};setTab('explore');openStations();$('collection').scrollTop=0;});
$('zoom-in').addEventListener('click',()=>globe.zoomBy(1.25));
$('zoom-out').addEventListener('click',()=>globe.zoomBy(0.8));
$('reset-globe').addEventListener('click',()=>{globe.reset();near=null;placeScope=null;render();});
$('surprise').addEventListener('click',surprise); $('next-station').addEventListener('click',surprise);
$('play-toggle').addEventListener('click',()=>{if(phase==='playing'||phase==='connecting') pause(); else if(current) playStation(current);});
$('player-favorite').addEventListener('click',()=>toggleFavorite(current));
audio.volume=Number.isFinite(saved.volume)?Math.max(0,Math.min(1,saved.volume)):0.6;
$('volume').value=audio.volume;
$('volume').addEventListener('input',()=>{audio.volume=Number($('volume').value);});
$('volume').addEventListener('change',persist);
$('about-open').addEventListener('click',()=>$('about-dialog').showModal());
$('about-close').addEventListener('click',()=>$('about-dialog').close());
$('about-dialog').addEventListener('click',event=>{if(event.target===$('about-dialog')){const r=$('about-dialog').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)$('about-dialog').close();}});
if('mediaSession' in navigator) {
  for(const [action,handler] of Object.entries({play:()=>current&&playStation(current),pause,stop:pause,nexttrack:surprise})) {
    try{navigator.mediaSession.setActionHandler(action,handler);}catch{/* Optional platform action. */}
  }
}
window.addEventListener('pagehide',pause);
loadDirectory();
