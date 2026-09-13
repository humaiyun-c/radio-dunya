// Geographic regions follow UN M49, with Russia explicitly included in spreading.
// https://unstats.un.org/unsd/methodology/m49/
// North America includes Central America and the Caribbean. Overseas territories
// follow their own country code; Kosovo is included in Europe.
const excluded = new Set(('AX AL AD AT BY BE BA BG HR CZ DK EE FO FI FR DE GI GR GG VA HU IS IE IM IT JE LV LI LT LU MT MD MC ME NL MK NO PL PT RO SM RS SK SI ES SJ SE CH UA GB XK '
  + 'CA US MX BM GL PM BZ CR SV GT HN NI PA AI AG AW BS BB BQ VG KY CU CW DM DO GD GP HT JM MQ MS PR BL KN LC MF VC SX TT TC VI').split(' '));
const FAN_RADIUS = 18;
const MAX_FAN_MEMBERS = 6;
const GRID_SIZE = 48;
const CLUSTER_RADIUS = 14;
const identity = station => `${station.id}\u0000${station.url}`;

export function canSpreadPins(countryCode) {
  const code = String(countryCode || '').toUpperCase();
  return /^[A-Z]{2}$/.test(code) && !excluded.has(code);
}

/**
 * Only fan small, isolated shared locations. Every offset is at most 18 CSS px;
 * crowded locations remain at their own anchors, regardless of station count.
 * Nearby anchors may share a marker within 14 px of an existing anchor; groups
 * never chain together or grow beyond that radius. Coordinates stay untouched.
 */
export function spreadPins(projected, {width = Infinity, height = Infinity} = {}) {
  const cells = new Map(), claimed = new Set(), groups = [];
  const ordered = [...projected].sort((a,b) => b.stations.length - a.stations.length
    || identity(a.stations[0]).localeCompare(identity(b.stations[0])));
  for (const group of ordered) {
    if (!group.spread) continue;
    const key = `${group.countryCode}:${Math.floor(group.x / CLUSTER_RADIUS)},${Math.floor(group.y / CLUSTER_RADIUS)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(group);
  }
  for (const anchor of ordered) {
    if (claimed.has(anchor)) continue;
    claimed.add(anchor);
    const group = {...anchor, stations:[...anchor.stations], places:1};
    if (anchor.spread) {
      const gx = Math.floor(anchor.x / CLUSTER_RADIUS), gy = Math.floor(anchor.y / CLUSTER_RADIUS);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const other of cells.get(`${anchor.countryCode}:${gx + dx},${gy + dy}`) || []) {
          if (claimed.has(other) || Math.hypot(anchor.x - other.x, anchor.y - other.y) >= CLUSTER_RADIUS) continue;
          claimed.add(other);
          group.stations.push(...other.stations);
          group.places++;
        }
      }
    }
    groups.push(group);
  }
  const neighbors = new Map();
  const candidates = new Set(groups.filter(group => group.spread && group.places === 1
    && group.stations.length >= 2 && group.stations.length <= MAX_FAN_MEMBERS));
  for (const group of groups) {
    const key = `${Math.floor(group.x / GRID_SIZE)},${Math.floor(group.y / GRID_SIZE)}`;
    if (!neighbors.has(key)) neighbors.set(key, []);
    neighbors.get(key).push(group);
  }
  const canFan = group => {
    const edge = FAN_RADIUS + 10;
    if (!candidates.has(group) || group.x < edge || group.y < edge
      || group.x > width - edge || group.y > height - edge) return false;
    const gx = Math.floor(group.x / GRID_SIZE), gy = Math.floor(group.y / GRID_SIZE);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const other of neighbors.get(`${gx + dx},${gy + dy}`) || []) {
        if (other === group) continue;
        const extent = candidates.has(other) ? FAN_RADIUS : other.stations.length > 1 ? 7 : 3.3;
        if (Math.hypot(group.x - other.x, group.y - other.y) < FAN_RADIUS + extent + 10) return false;
      }
    }
    return true;
  };
  const pins = [];
  for (const group of groups) {
    if (!canFan(group)) {
      pins.push({station:group.stations[0], stations:group.stations, x:group.x, y:group.y,
        anchorX:group.x, anchorY:group.y, expanded:false,
        clustered:group.spread && group.stations.length > 1});
      continue;
    }
    const stations = [...group.stations].sort((a,b) => identity(a).localeCompare(identity(b)));
    stations.forEach((station,i) => {
      const angle = 2 * Math.PI * i / stations.length - Math.PI / 2;
      pins.push({station, stations:[station], x:group.x + FAN_RADIUS * Math.cos(angle), y:group.y + FAN_RADIUS * Math.sin(angle),
        anchorX:group.x, anchorY:group.y, expanded:true, clustered:false});
    });
  }
  return pins;
}
