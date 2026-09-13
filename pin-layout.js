// Geographic regions follow UN M49, with Russia explicitly included in spreading.
// https://unstats.un.org/unsd/methodology/m49/
// North America includes Central America and the Caribbean. Overseas territories
// follow their own country code; Kosovo is included in Europe.
const excluded = new Set(('AX AL AD AT BY BE BA BG HR CZ DK EE FO FI FR DE GI GR GG VA HU IS IE IM IT JE LV LI LT LU MT MD MC ME NL MK NO PL PT RO SM RS SK SI ES SJ SE CH UA GB XK '
  + 'CA US MX BM GL PM BZ CR SV GT HN NI PA AI AG AW BS BB BQ VG KY CU CW DM DO GD GP HT JM MQ MS PR BL KN LC MF VC SX TT TC VI').split(' '));
const SPACING = 18;
const OVERLAP = 12;
const identity = station => `${station.id}\u0000${station.url}`;

export function canSpreadPins(countryCode) {
  const code = String(countryCode || '').toUpperCase();
  return /^[A-Z]{2}$/.test(code) && !excluded.has(code);
}

function gridKey(x, y, size) {
  return `${Math.floor(x / size)},${Math.floor(y / size)}`;
}

function *hexagonSlots(x, y) {
  yield { x, y };
  const directions = [[-1, 1], [-1, 0], [0, -1], [1, -1], [1, 0], [0, 1]];
  for (let ring = 1; ; ring++) {
    let q = ring, r = 0;
    for (const [dq, dr] of directions) {
      for (let step = 0; step < ring; step++) {
        yield { x: x + SPACING * (q + r / 2), y: y + SPACING * Math.sqrt(3) / 2 * r };
        q += dq; r += dr;
      }
    }
  }
}

/**
 * Spread projected, eligible groups in CSS pixels. Real station coordinates and
 * identities are untouched. A screen grid keeps work local, without a simulation.
 * Each input group has {x, y, stations, spread}; excluded groups stay fixed.
 */
export function spreadPins(groups) {
  const pins = [], occupied = new Map(), nearby = new Map();
  const eligible = groups.filter(group => group.spread)
    .sort((a, b) => identity(a.stations[0]).localeCompare(identity(b.stations[0])));
  const parent = eligible.map((_, i) => i);
  const root = i => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const add = pin => {
    pins.push(pin);
    const key = gridKey(pin.x, pin.y, SPACING);
    if (!occupied.has(key)) occupied.set(key, []);
    occupied.get(key).push(pin);
  };
  const vacant = ({x, y}) => {
    const gx = Math.floor(x / SPACING), gy = Math.floor(y / SPACING);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const pin of occupied.get(`${gx + dx},${gy + dy}`) || []) {
        if ((pin.x - x) ** 2 + (pin.y - y) ** 2 < SPACING ** 2 - 0.01) return false;
      }
    }
    return true;
  };
  const pinAt = (group, station, point = group) => ({
    station, x: point.x, y: point.y, anchorX: group.x, anchorY: group.y, expanded: group.spread,
  });

  for (const group of groups) {
    if (!group.spread) add(pinAt(group, group.stations[0]));
  }
  // Join overlapping anchors, not every co-located station: a city with hundreds
  // of streams remains one entry in this lookup.
  eligible.forEach((group, i) => {
    const gx = Math.floor(group.x / OVERLAP), gy = Math.floor(group.y / OVERLAP);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const j of nearby.get(`${gx + dx},${gy + dy}`) || []) {
        const other = eligible[j];
        if ((group.x - other.x) ** 2 + (group.y - other.y) ** 2 < OVERLAP ** 2) parent[root(i)] = root(j);
      }
    }
    const key = gridKey(group.x, group.y, OVERLAP);
    if (!nearby.has(key)) nearby.set(key, []);
    nearby.get(key).push(i);
  });
  const clusters = new Map();
  eligible.forEach((group, i) => {
    const key = root(i);
    if (!clusters.has(key)) clusters.set(key, []);
    for (const station of group.stations) clusters.get(key).push({group, station});
  });
  const crowded = [];
  for (const cluster of clusters.values()) {
    if (cluster.length === 1 && vacant(cluster[0].group)) add(pinAt(cluster[0].group, cluster[0].station));
    else {
      cluster.sort((a, b) => identity(a.station).localeCompare(identity(b.station)));
      crowded.push(cluster);
    }
  }
  crowded.sort((a, b) => identity(a[0].station).localeCompare(identity(b[0].station)));
  for (const cluster of crowded) {
    const x = cluster.reduce((sum, member) => sum + member.group.x, 0) / cluster.length;
    const y = cluster.reduce((sum, member) => sum + member.group.y, 0) / cluster.length;
    const slots = hexagonSlots(x, y);
    cluster.forEach(({group, station}, i) => {
      const angle = 2 * Math.PI * i / cluster.length - Math.PI / 2;
      const radius = Math.max(12, SPACING / (2 * Math.sin(Math.PI / cluster.length)));
      let point = cluster.length >= 2 && cluster.length <= 8 ? {x: x + radius * Math.cos(angle), y: y + radius * Math.sin(angle)} : slots.next().value;
      while (!vacant(point)) point = slots.next().value;
      add(pinAt(group, station, point));
    });
  }
  return pins;
}
