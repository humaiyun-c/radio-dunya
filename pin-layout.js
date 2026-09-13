// Geographic regions follow UN M49, with Russia explicitly included in spreading.
// https://unstats.un.org/unsd/methodology/m49/
// North America includes Central America and the Caribbean. Overseas territories
// follow their own country code; Kosovo is included in Europe.
const excluded = new Set(('AX AL AD AT BY BE BA BG HR CZ DK EE FO FI FR DE GI GR GG VA HU IS IE IM IT JE LV LI LT LU MT MD MC ME NL MK NO PL PT RO SM RS SK SI ES SJ SE CH UA GB XK '
  + 'CA US MX BM GL PM BZ CR SV GT HN NI PA AI AG AW BS BB BQ VG KY CU CW DM DO GD GP HT JM MQ MS PR BL KN LC MF VC SX TT TC VI').split(' '));
const CLUSTER_RADIUS = 14;
const GROUP_RADIUS = 0.08 * Math.PI / 180;
const identity = station => `${station.id}\u0000${station.url}`;

export function canSpreadPins(countryCode) {
  const code = String(countryCode || '').toUpperCase();
  return /^[A-Z]{2}$/.test(code) && !excluded.has(code);
}

// Stable local display positions, prepared from the whole catalog so filtering
// does not shuffle a city's dots. Original station coordinates are never edited.
export function stationPositions(stations, locationFor) {
  const groups = new Map(), positions = new Map();
  for (const station of stations) {
    const location = locationFor(station);
    if (!location) continue;
    const code = String(location.countryCode || station.countryCode || '').toUpperCase();
    const key = `${location.lat},${location.lon}`;
    if (!groups.has(key)) groups.set(key, {location, code, allowed:canSpreadPins(code), stations:new Map()});
    const group = groups.get(key);
    group.allowed &&= code === group.code && canSpreadPins(code);
    group.stations.set(identity(station), station);
    positions.set(identity(station), {lat:location.lat, lon:location.lon});
  }
  for (const group of groups.values()) {
    const records = [...group.stations.values()].sort((a,b) => identity(a).localeCompare(identity(b)));
    if (!group.allowed || records.length < 2) continue;
    // A compact hexagonal arrangement has predictable spacing even for hundreds
    // of channels. Its geographic footprint is bounded to about 9 km.
    const points = [{x:0,y:0}];
    const directions = [[-1,1],[-1,0],[0,-1],[1,-1],[1,0],[0,1]];
    for (let ring = 1; points.length < records.length; ring++) {
      let q = ring, r = 0;
      for (const [dq,dr] of directions) for (let step = 0; step < ring; step++) {
        if (points.length < records.length) points.push({x:q+r/2,y:Math.sqrt(3)/2*r});
        q += dq; r += dr;
      }
    }
    const cx = points.reduce((sum,p)=>sum+p.x,0)/points.length;
    const cy = points.reduce((sum,p)=>sum+p.y,0)/points.length;
    const extent = Math.max(...points.map(p=>Math.hypot(p.x-cx,p.y-cy)));
    const lat = group.location.lat * Math.PI/180, lon = group.location.lon * Math.PI/180;
    points.forEach((p,i)=>{
      const x=p.x-cx, y=p.y-cy, distance=GROUP_RADIUS*Math.hypot(x,y)/extent, bearing=Math.atan2(x,y);
      const north=Math.asin(Math.sin(lat)*Math.cos(distance)+Math.cos(lat)*Math.sin(distance)*Math.cos(bearing));
      const east=lon+Math.atan2(Math.sin(bearing)*Math.sin(distance)*Math.cos(lat),Math.cos(distance)-Math.sin(lat)*Math.sin(north));
      positions.set(identity(records[i]),{lat:north*180/Math.PI,lon:((east*180/Math.PI+180)%360+360)%360-180});
    });
  }
  return positions;
}

// Group only dots that still overlap on screen. As the globe zooms, these groups
// naturally split down to individual stations. No rings or artificial outer fans.
export function spreadPins(projected) {
  const cells = new Map(), claimed = new Set(), pins = [];
  const ordered = [...projected].sort((a,b)=>identity(a.station).localeCompare(identity(b.station)));
  for (const point of ordered) {
    if (!point.spread) continue;
    const key = `${point.countryCode}:${Math.floor(point.x/CLUSTER_RADIUS)},${Math.floor(point.y/CLUSTER_RADIUS)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(point);
  }
  for (const anchor of ordered) {
    if (claimed.has(anchor)) continue;
    claimed.add(anchor);
    const members = [...anchor.stations];
    if (anchor.spread) {
      const gx=Math.floor(anchor.x/CLUSTER_RADIUS), gy=Math.floor(anchor.y/CLUSTER_RADIUS);
      for (let dx=-1;dx<=1;dx++) for (let dy=-1;dy<=1;dy++) {
        for (const other of cells.get(`${anchor.countryCode}:${gx+dx},${gy+dy}`)||[]) {
          if (claimed.has(other)||Math.hypot(anchor.x-other.x,anchor.y-other.y)>=CLUSTER_RADIUS) continue;
          claimed.add(other);members.push(...other.stations);
        }
      }
    }
    pins.push({...anchor,stations:members,expanded:anchor.spread&&members.length===1,
      clustered:anchor.spread&&members.length>1,canZoom:anchor.spread&&members.length>1});
  }
  return pins;
}