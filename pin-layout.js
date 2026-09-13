// Geographic regions follow UN M49, with Russia explicitly included in spreading.
// https://unstats.un.org/unsd/methodology/m49/
// North America includes Central America and the Caribbean. Overseas territories
// follow their own country code; Kosovo is included in Europe.
const excluded = new Set(('AX AL AD AT BY BE BA BG HR CZ DK EE FO FI FR DE GI GR GG VA HU IS IE IM IT JE LV LI LT LU MT MD MC ME NL MK NO PL PT RO SM RS SK SI ES SJ SE CH UA GB XK '
  + 'CA US MX BM GL PM BZ CR SV GT HN NI PA AI AG AW BS BB BQ VG KY CU CW DM DO GD GP HT JM MQ MS PR BL KN LC MF VC SX TT TC VI').split(' '));
// Africa and Asia show every station at every zoom. China, Hong Kong and Macao
// retain progressive clustering; Russia remains included by product preference.
const alwaysIndividual = new Set(('DZ AO BJ BW BF BI CV CM CF TD KM CG CD CI DJ EG GQ ER SZ ET GA GM GH GN GW IO KE LS LR LY MG MW ML MR MU YT MA MZ NA NE NG RE RW SH ST SN SC SL SO ZA SS SD TF TZ TG TN UG EH ZM ZW '
  + 'AF AM AZ BH BD BT BN KH CY GE IN ID IR IQ IL JP JO KZ KW KG LA LB MY MV MN MM NP KP OM PK PS PH QA SA SG KR LK SY TW TJ TH TL TR TM AE UZ VN YE RU').split(' '));
const CLUSTER_RADIUS = 14;
const GROUP_RADIUS = 0.08 * Math.PI / 180;
const CLOUD_STEP = Math.PI / 180;
const identity = station => `${station.id}\u0000${station.url}`;
const hash = value => { let n=2166136261;for(const char of value){n^=char.charCodeAt(0);n=Math.imul(n,16777619);}return n>>>0; };

function cloudPoints(count, seed) {
  const points=[], cells=new Map(), gap=.85;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  let radius=Math.sqrt(count)*.63;
  while(points.length<count) {
    let placed=false;
    for(let attempt=0;attempt<100&&!placed;attempt++) {
      const r=Math.sqrt(random())*radius, angle=random()*Math.PI*2;
      const p={x:Math.cos(angle)*r,y:Math.sin(angle)*r}, gx=Math.floor(p.x/gap), gy=Math.floor(p.y/gap);
      let crowded=false;
      for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const q of cells.get(`${gx+dx},${gy+dy}`)||[])
        if(Math.hypot(q.x-p.x,q.y-p.y)<gap)crowded=true;
      if(crowded)continue;
      const key=`${gx},${gy}`;if(!cells.has(key))cells.set(key,[]);cells.get(key).push(p);points.push(p);placed=true;
    }
    if(!placed)radius*=1.1;
  }
  return points;
}

export function canSpreadPins(countryCode) {
  const code = String(countryCode || '').toUpperCase();
  return /^[A-Z]{2}$/.test(code) && !excluded.has(code);
}

export function showEveryStation(countryCode) {
  return alwaysIndividual.has(String(countryCode || '').trim().toUpperCase());
}

export function cloudLocation(point, zoom) {
  if (!point?.cloud) return point;
  const {lat,lon,distance,bearing}=point.cloud, step=distance/Math.sqrt(Math.max(1,zoom));
  const north=Math.asin(Math.sin(lat)*Math.cos(step)+Math.cos(lat)*Math.sin(step)*Math.cos(bearing));
  const east=lon+Math.atan2(Math.sin(bearing)*Math.sin(step)*Math.cos(lat),Math.cos(step)-Math.sin(lat)*Math.sin(north));
  return {lat:north*180/Math.PI,lon:((east*180/Math.PI+180)%360+360)%360-180};
}

// Stable local display positions, prepared from the whole catalog so filtering
// does not shuffle a city's dots. Original station coordinates are never edited.
export function stationPositions(stations, locationFor) {
  const groups = new Map(), positions = new Map();
  for (const station of stations) {
    const location = locationFor(station);
    if (!location) continue;
    const code = String(location.countryCode || station.countryCode || '').toUpperCase();
    const key = `${location.lat},${location.lon}${showEveryStation(code)?`:${code}`:''}`;
    if (!groups.has(key)) groups.set(key, {location, code, allowed:canSpreadPins(code), stations:new Map()});
    const group = groups.get(key);
    group.allowed &&= code === group.code && canSpreadPins(code);
    group.stations.set(identity(station), station);
    positions.set(identity(station), {lat:location.lat, lon:location.lon});
  }
  for (const group of groups.values()) {
    const records = [...group.stations.values()].sort((a,b) => identity(a).localeCompare(identity(b)));
    if (!group.allowed || records.length < 2) continue;
    // Filled local clouds preserve every original station. China and the other
    // progressively grouped regions retain their small, 9 km display footprint.
    const individual = showEveryStation(group.code);
    const points = individual ? cloudPoints(records.length,hash(`${group.code}:${group.location.lat},${group.location.lon}`)) : [{x:0,y:0}];
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
      const x=p.x-cx, y=p.y-cy;
      const distance=Math.hypot(x,y)*(individual?CLOUD_STEP:GROUP_RADIUS/extent), bearing=Math.atan2(x,y);
      const north=Math.asin(Math.sin(lat)*Math.cos(distance)+Math.cos(lat)*Math.sin(distance)*Math.cos(bearing));
      const east=lon+Math.atan2(Math.sin(bearing)*Math.sin(distance)*Math.cos(lat),Math.cos(distance)-Math.sin(lat)*Math.sin(north));
      positions.set(identity(records[i]),{lat:north*180/Math.PI,lon:((east*180/Math.PI+180)%360+360)%360-180,
        ...(individual?{cloud:{lat,lon,distance,bearing}}:{})});
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
