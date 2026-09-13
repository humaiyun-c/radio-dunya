// D3's orthographic projection and Canvas path contracts:
// https://d3js.org/d3-geo/projection and https://d3js.org/d3-geo/path
// This module redraws only after input, resize, or a data change.

const RADIANS = Math.PI / 180;
const INITIAL_VIEW = { lat: 20, lon: 15 };
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const wrapLongitude = value => ((value + 180) % 360 + 360) % 360 - 180;
const hasCoordinates = station => station && Number.isFinite(station.lat)
  && Number.isFinite(station.lon) && Math.abs(station.lat) <= 90 && Math.abs(station.lon) <= 180;

/**
 * Create an event-driven globe. Load the three vendor scripts before this module.
 * Station coordinates are numeric lat/lon in degrees; missing coordinates are skipped.
 * onSelect and onHover receive the original station object, never a clone.
 */
export function createGlobe(canvas, { onSelect = () => {}, onViewChange = () => {}, onHover = () => {} } = {}) {
  const { d3, topojson } = globalThis;
  if (!d3?.geoOrthographic || !topojson?.feature || !topojson?.mesh) throw new Error('The local globe libraries did not load.');
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) throw new Error('This browser does not support the globe canvas.');

  const lifetime = new AbortController();
  const projection = d3.geoOrthographic().clipAngle(90).precision(0.5);
  const path = d3.geoPath(projection, context);
  const graticule = d3.geoGraticule().step([30, 30])();
  const pointers = new Map();
  const previousTouchAction = canvas.style.touchAction;
  const previousCursor = canvas.style.cursor;
  canvas.style.touchAction = 'none';
  canvas.style.cursor = 'grab';

  let view = { ...INITIAL_VIEW };
  let zoom = 1;
  let width = 1;
  let height = 1;
  let radius = 1;
  let frame = 0;
  let destroyed = false;
  let viewChanged = true;
  let land = null;
  let borders = null;
  let stations = [];
  let visiblePins = [];
  let selected = null;
  let hovered = null;
  let gesture = null;

  function invalidate(changedView = false) {
    if (destroyed) return;
    viewChanged ||= changedView;
    if (!frame) frame = requestAnimationFrame(draw);
  }

  function colors() {
    const style = getComputedStyle(canvas);
    const value = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
    return {
      ocean: value('--globe-ocean', '#14344b'),
      land: value('--globe-land', '#466b7f'),
      grid: value('--globe-grid', '#355568'),
      line: value('--globe-line', '#7893a1'),
      border: value('--globe-border', '#9ab3c1'),
      pin: value('--globe-pin', '#f4c36a'),
      selected: value('--globe-selected', '#ffffff'),
    };
  }

  function circle(x, y, r) {
    context.moveTo(x + r, y);
    context.arc(x, y, r, 0, Math.PI * 2);
  }

  function projectedStation(station) {
    if (!hasCoordinates(station)) return null;
    const lat = station.lat * RADIANS;
    const centerLat = view.lat * RADIANS;
    const facing = Math.sin(lat) * Math.sin(centerLat)
      + Math.cos(lat) * Math.cos(centerLat) * Math.cos((station.lon - view.lon) * RADIANS);
    // projection(point) alone does not apply hemisphere clipping.
    if (facing <= 0.012) return null;
    const point = projection([station.lon, station.lat]);
    if (!point || point[0] < -12 || point[0] > width + 12 || point[1] < -12 || point[1] > height + 12) return null;
    return { station, x: point[0], y: point[1] };
  }

  function draw() {
    frame = 0;
    if (destroyed) return;
    const bounds = canvas.getBoundingClientRect();
    width = Math.max(1, bounds.width);
    height = Math.max(1, bounds.height);
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
    const pixelsWide = Math.round(width * ratio);
    const pixelsHigh = Math.round(height * ratio);
    if (canvas.width !== pixelsWide) canvas.width = pixelsWide;
    if (canvas.height !== pixelsHigh) canvas.height = pixelsHigh;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    radius = Math.max(1, Math.min(width, height) * 0.485 * zoom);
    projection.translate([width / 2, height / 2]).scale(radius).rotate([-view.lon, -view.lat, 0]);
    const palette = colors();

    context.beginPath();
    circle(width / 2, height / 2, radius);
    context.fillStyle = palette.ocean;
    context.fill();

    if (land) {
      context.beginPath();
      path(land);
      context.fillStyle = palette.land;
      context.fill();
      context.lineWidth = 0.65;
      context.strokeStyle = palette.line;
      context.globalAlpha = 0.6;
      context.stroke();
      context.globalAlpha = 1;
    }

    context.beginPath();
    path(graticule);
    context.lineWidth = 0.6;
    context.strokeStyle = palette.grid;
    context.stroke();

    if (borders) {
      context.beginPath();
      path(borders);
      context.lineWidth = 0.9;
      context.strokeStyle = palette.border;
      context.stroke();
    }

    // One atmospheric ring; no texture downloads, shaders, or animation loop.
    context.beginPath();
    circle(width / 2, height / 2, radius + 5);
    context.strokeStyle = palette.line;
    context.globalAlpha = 0.3;
    context.lineWidth = 1;
    context.stroke();
    context.globalAlpha = 1;

    visiblePins = [];
    const pinRadius = Math.min(3.3, 1.75 + Math.log2(zoom + 1) * 0.35);
    context.beginPath();
    for (const station of stations) {
      const point = projectedStation(station);
      if (!point) continue;
      visiblePins.push(point);
      circle(point.x, point.y, pinRadius);
    }
    context.fillStyle = palette.pin;
    context.globalAlpha = 0.88;
    context.fill();
    context.globalAlpha = 1;

    for (const station of [hovered, selected]) {
      const point = projectedStation(station);
      if (!point) continue;
      const isSelected = station === selected;
      context.beginPath();
      circle(point.x, point.y, isSelected ? 10 : 7);
      context.lineWidth = isSelected ? 1.7 : 1;
      context.strokeStyle = isSelected ? palette.selected : palette.pin;
      context.stroke();
      context.beginPath();
      circle(point.x, point.y, isSelected ? 4 : 3);
      context.fillStyle = isSelected ? palette.selected : palette.pin;
      context.fill();
    }

    if (viewChanged) {
      viewChanged = false;
      onViewChange({ ...view });
    }
  }

  function localPoint(event) {
    const bounds = canvas.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  function insideSphere(point) {
    return Math.hypot(point.x - width / 2, point.y - height / 2) <= radius + 6;
  }

  function hitTest(point, tolerance = 13) {
    let closest = null;
    let distanceSquared = tolerance * tolerance;
    for (const pin of visiblePins) {
      const distance = (point.x - pin.x) ** 2 + (point.y - pin.y) ** 2;
      if (distance < distanceSquared) {
        distanceSquared = distance;
        closest = pin.station;
      }
    }
    return closest;
  }

  function hover(station) {
    if (hovered === station) return;
    hovered = station;
    onHover(station);
    invalidate();
  }

  function startGesture(moved = false) {
    const points = [...pointers.values()];
    if (!points.length) {
      gesture = null;
      return;
    }
    gesture = {
      x: points[0].x,
      y: points[0].y,
      view: { ...view },
      zoom,
      distance: points.length > 1 ? Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) : 0,
      moved: moved || points.length > 1,
    };
  }

  function pointerDown(event) {
    canvas.classList.remove('keyboard-focus');
    if (event.button !== 0) return;
    const point = localPoint(event);
    if (!insideSphere(point)) return;
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, point);
    startGesture(pointers.size > 1);
    hover(null);
    canvas.style.cursor = 'grabbing';
  }

  function pointerMove(event) {
    const point = localPoint(event);
    if (!pointers.has(event.pointerId)) {
      const target = insideSphere(point) ? hitTest(point) : null;
      hover(target);
      canvas.style.cursor = target ? 'pointer' : 'grab';
      return;
    }
    pointers.set(event.pointerId, point);
    const points = [...pointers.values()];
    if (points.length > 1 && gesture.distance > 0) {
      const distance = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
      zoom = clamp(gesture.zoom * distance / gesture.distance, 0.8, 6);
      gesture.moved = true;
      invalidate();
      return;
    }
    const dx = point.x - gesture.x;
    const dy = point.y - gesture.y;
    if (Math.hypot(dx, dy) > 5) gesture.moved = true;
    if (!gesture.moved) return;
    const sensitivity = 75 / radius;
    view.lon = wrapLongitude(gesture.view.lon - dx * sensitivity);
    view.lat = clamp(gesture.view.lat + dy * sensitivity, -89.5, 89.5);
    invalidate(true);
  }

  function pointerEnd(event) {
    if (!pointers.has(event.pointerId)) return;
    const shouldSelect = event.type === 'pointerup' && pointers.size === 1 && !gesture?.moved;
    pointers.delete(event.pointerId);
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    startGesture(true);
    canvas.style.cursor = pointers.size ? 'grabbing' : 'grab';
    if (shouldSelect) {
      const station = hitTest(localPoint(event), event.pointerType === 'touch' ? 24 : 13);
      if (station) onSelect(station);
    }
  }

  function zoomBy(factor) {
    if (!Number.isFinite(factor) || factor <= 0) return;
    zoom = clamp(zoom * factor, 0.8, 6);
    hover(null);
    invalidate();
  }

  function keyDown(event) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const step = (event.shiftKey ? 15 : 6) / zoom;
    if (event.key === 'ArrowLeft') view.lon = wrapLongitude(view.lon - step);
    else if (event.key === 'ArrowRight') view.lon = wrapLongitude(view.lon + step);
    else if (event.key === 'ArrowUp') view.lat = clamp(view.lat + step, -89.5, 89.5);
    else if (event.key === 'ArrowDown') view.lat = clamp(view.lat - step, -89.5, 89.5);
    else if (event.key === '+' || event.key === '=') zoomBy(1.2);
    else if (event.key === '-' || event.key === '_') zoomBy(1 / 1.2);
    else if (event.key === 'Home') { view = { ...INITIAL_VIEW }; zoom = 1; }
    else if (event.key === 'Enter' || event.key === ' ') {
      const station = hitTest({ x: width / 2, y: height / 2 }, Infinity);
      if (station) onSelect(station);
    } else return;
    canvas.classList.add('keyboard-focus');
    event.preventDefault();
    hover(null);
    invalidate(true);
  }

  const listen = (name, handler, options = {}) => canvas.addEventListener(name, handler, { ...options, signal: lifetime.signal });
  listen('pointerdown', pointerDown);
  listen('pointermove', pointerMove);
  listen('pointerup', pointerEnd);
  listen('pointercancel', pointerEnd);
  listen('lostpointercapture', pointerEnd);
  listen('pointerleave', () => { if (!pointers.size) hover(null); });
  listen('keydown', keyDown);
  listen('blur', () => canvas.classList.remove('keyboard-focus'));
  document.addEventListener('keydown', event => {
    if (event.key === 'Tab') canvas.classList.add('keyboard-focus');
  }, { signal: lifetime.signal });
  listen('wheel', event => {
    if (!insideSphere(localPoint(event))) return;
    event.preventDefault();
    const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1;
    zoomBy(Math.exp(-clamp(event.deltaY * units, -100, 100) * 0.002));
  }, { passive: false });

  const resizeObserver = new ResizeObserver(() => invalidate());
  resizeObserver.observe(canvas);

  // One world-atlas 2.0.2 file supplies Natural Earth 1:110m land and countries.
  // https://github.com/topojson/topojson-client#feature and #mesh
  fetch(new URL('./assets/countries-110m.json', import.meta.url), { signal: lifetime.signal })
    .then(response => {
      if (!response.ok) throw new Error(`World map returned ${response.status}.`);
      return response.json();
    })
    .then(topology => {
      if (destroyed) return;
      land = topojson.feature(topology, topology.objects.land);
      borders = topojson.mesh(topology, topology.objects.countries, (a, b) => a !== b);
      invalidate();
    })
    .catch(error => {
      if (destroyed || error.name === 'AbortError') return;
      canvas.dispatchEvent(new CustomEvent('globeerror', { detail: 'The world map could not load. Stations are still available in the list.' }));
    });

  invalidate(true);
  return {
    setStations(nextStations) {
      stations = Array.isArray(nextStations) ? nextStations.filter(hasCoordinates) : [];
      hover(null);
      invalidate();
    },
    selectStation(station) {
      selected = station || null;
      invalidate();
    },
    focusStation(station) {
      if (!hasCoordinates(station)) return;
      view = { lat: clamp(station.lat, -89.5, 89.5), lon: wrapLongitude(station.lon) };
      hover(null);
      invalidate(true);
    },
    zoomBy,
    reset() {
      view = { ...INITIAL_VIEW };
      zoom = 1;
      hover(null);
      invalidate(true);
    },
    destroy() {
      destroyed = true;
      lifetime.abort();
      resizeObserver.disconnect();
      if (frame) cancelAnimationFrame(frame);
      for (const pointerId of pointers.keys()) {
        if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
      }
      pointers.clear();
      canvas.classList.remove('keyboard-focus');
      canvas.style.touchAction = previousTouchAction;
      canvas.style.cursor = previousCursor;
    },
  };
}
