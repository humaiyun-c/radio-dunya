// D3's orthographic projection and Canvas path contracts:
// https://d3js.org/d3-geo/projection and https://d3js.org/d3-geo/path
// This module redraws after input/data changes and during gesture/navigation springs.

import { getMapLocation, isMappable } from './station-location.js?v=glass-player-1';

const RADIANS = Math.PI / 180;
const INITIAL_VIEW = { lat: 20, lon: 15 };
const MAX_ZOOM = 54;
// Apple recommends direct manipulation and gives 80% damping for momentum gestures:
// https://developer.apple.com/videos/play/wwdc2018/803/
// Response and travel below are tuned for this globe, not prescribed Apple values.
const RELEASE_DAMPING = 0.8;
const RELEASE_RESPONSE = 0.4;
const RELEASE_PROJECTION = 0.12;
// This spring peaks at 1.0196 times its projected travel; leave a little margin.
const RELEASE_PEAK = 1.03;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const wrapLongitude = value => ((value + 180) % 360 + 360) % 360 - 180;
const locationKey = location => `${location.lat},${location.lon}`;

/**
 * Create an event-driven globe. Load the three vendor scripts before this module.
 * Pins use resolved locations, including approximate city/capital locations.
 * Stations without a resolved location are skipped; raw coordinates are preserved.
 * onSelect and onHover receive the original station object, never a clone.
 */
export function createGlobe(canvas, { onSelect = () => {}, onViewChange = () => {}, onHover = () => {}, onBackgroundTap = () => {} } = {}) {
  const { d3, topojson } = globalThis;
  if (!d3?.geoOrthographic || !topojson?.feature || !topojson?.mesh) throw new Error('The local globe libraries did not load.');
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) throw new Error('This browser does not support the globe canvas.');

  const lifetime = new AbortController();
  const projection = d3.geoOrthographic().clipAngle(90).precision(0.5);
  const path = d3.geoPath(projection, context);
  const graticule = d3.geoGraticule().step([30, 30])();
  const pointers = new Map();
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
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
  let groups = [];
  let locationGroups = new Map();
  let stationStreams = new Map();
  let visiblePins = [];
  let selected = null;
  let hovered = null;
  let gesture = null;
  let release = null;

  function stopRelease(settleNavigation = false) {
    if (settleNavigation && release?.navigation) {
      view = { lon: wrapLongitude(release.to.lon), lat: release.to.lat };
      zoom = release.targetZoom;
      invalidate(true);
    }
    release = null;
  }

  // Exact damped-spring solution: stable at 60/120 Hz and after a delayed frame.
  function springAxis(start, target, velocity, elapsed, response = RELEASE_RESPONSE, damping = RELEASE_DAMPING) {
    const omega = 2 * Math.PI / response;
    const offset = start - target;
    if (damping === 1) {
      const slope = velocity + omega * offset;
      const envelope = Math.exp(-omega * elapsed);
      return {
        position: target + (offset + slope * elapsed) * envelope,
        velocity: (velocity - omega * slope * elapsed) * envelope,
      };
    }
    const decay = damping * omega;
    const frequency = omega * Math.sqrt(1 - damping ** 2);
    const sine = (velocity + decay * offset) / frequency;
    const envelope = Math.exp(-decay * elapsed);
    const cos = Math.cos(frequency * elapsed);
    const sin = Math.sin(frequency * elapsed);
    const displacement = offset * cos + sine * sin;
    return {
      position: target + envelope * displacement,
      velocity: envelope * ((sine * frequency - decay * offset) * cos
        - (offset * frequency + decay * sine) * sin),
    };
  }

  function advanceRelease(now) {
    if (!release) return;
    const elapsed = Math.max(0, (now - release.started) / 1000);
    const axis = name => springAxis(release.from[name], release.to[name], release.velocity[name], elapsed, release.response, release.damping);
    const lon = axis('lon');
    const lat = axis('lat');
    const scale = release.navigation ? axis('scale') : null;
    release.currentVelocity = { lon: lon.velocity, lat: lat.velocity, scale: scale?.velocity || 0 };
    const atRest = Math.hypot(lon.position - release.to.lon, lat.position - release.to.lat) < release.pixelAngle * 0.1
      && Math.hypot(lon.velocity, lat.velocity) < release.pixelAngle * 0.4
      && (!scale || (Math.abs(scale.position - release.to.scale) * release.targetRadius < 0.1
        && Math.abs(scale.velocity) * release.targetRadius < 0.4));
    view.lon = wrapLongitude(atRest ? release.to.lon : lon.position);
    view.lat = clamp(atRest ? release.to.lat : lat.position, -89.5, 89.5);
    if (scale) zoom = clamp(Math.exp(scale.position), 0.8, MAX_ZOOM);
    viewChanged = true;
    if (atRest || elapsed >= (release.navigation ? 3 : 1.2)) {
      view = { lon: wrapLongitude(release.to.lon), lat: release.to.lat };
      if (release.navigation) zoom = release.targetZoom;
      stopRelease();
    }
  }

  function animateView(target, targetZoom = zoom) {
    const destination = { lat: clamp(target.lat, -89.5, 89.5), lon: wrapLongitude(target.lon) };
    hover(null);
    if (reducedMotion.matches || document.hidden) {
      stopRelease();
      view = destination;
      zoom = targetZoom;
      invalidate(true);
      return;
    }
    const from = { ...view, scale: Math.log(zoom) };
    // Unwrap around the current pose so crossing the date line takes the short way.
    const to = { lat: destination.lat, lon: view.lon + wrapLongitude(destination.lon - view.lon), scale: Math.log(targetZoom) };
    const distance = Math.hypot(to.lon - from.lon, to.lat - from.lat);
    const response = 0.55 + 0.2 * Math.min(1, distance / 180);
    const incoming = release?.currentVelocity || release?.velocity || {};
    const velocity = {};
    for (const name of ['lon', 'lat', 'scale']) {
      const delta = to[name] - from[name];
      const speed = incoming[name] || 0;
      // Preserve useful momentum when retargeting, bounded to prevent passing the
      // destination. Apple's tap-driven spring example uses 100% damping.
      velocity[name] = speed * delta > 0 ? Math.sign(delta) * Math.min(Math.abs(speed), 2 * Math.PI / response * Math.abs(delta)) : 0;
    }
    const bounds = canvas.getBoundingClientRect();
    const targetRadius = Math.max(1, Math.min(bounds.width, bounds.height) * 0.485 * targetZoom);
    release = { from, to, velocity, response, damping: 1, navigation: true,
      targetZoom, targetRadius, pixelAngle: 1 / (targetRadius * RADIANS), started: performance.now() };
    invalidate(true);
  }

  function beginRelease(event, finishedGesture) {
    if (reducedMotion.matches || document.hidden || !finishedGesture?.moved) return;
    const samples = finishedGesture.samples.filter(sample => event.timeStamp - sample.time <= 100);
    if (samples.length < 2) return;
    const first = samples[0], last = samples[samples.length - 1];
    const seconds = (event.timeStamp - first.time) / 1000;
    if (seconds <= 0 || event.timeStamp - last.time > 70) return;
    const pixelsPerDegree = radius * RADIANS;
    let lon = (last.lon - first.lon) / seconds;
    let lat = (last.lat - first.lat) / seconds;
    const speed = Math.hypot(lon, lat) * pixelsPerDegree;
    if (speed < 18) return;
    // Bound travel in screen pixels so a flick stays local even at maximum zoom.
    const maxTravel = Math.min(100, width * 0.2, height * 0.15);
    const scale = Math.min(1, maxTravel / (speed * RELEASE_PROJECTION * RELEASE_PEAK));
    lon *= scale;
    lat *= scale;
    // Keep both target and inherited velocity inside the pole boundary, including
    // the small overshoot. This avoids clipping a spring then bouncing off a pole.
    if (lat) {
      const direction = Math.sign(lat);
      const available = 89.5 - direction * view.lat;
      lat = direction * Math.min(Math.abs(lat), available / (RELEASE_PROJECTION * RELEASE_PEAK));
    }
    release = {
      from: { ...view },
      to: { lon: view.lon + lon * RELEASE_PROJECTION, lat: clamp(view.lat + lat * RELEASE_PROJECTION, -89.5, 89.5) },
      velocity: { lon, lat }, pixelAngle: 1 / pixelsPerDegree, started: performance.now(),
    };
    invalidate(true);
  }

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

  function projectedStation(station, margin = 12) {
    const location = getMapLocation(station);
    if (!location) return null;
    const lat = location.lat * RADIANS;
    const centerLat = view.lat * RADIANS;
    const facing = Math.sin(lat) * Math.sin(centerLat)
      + Math.cos(lat) * Math.cos(centerLat) * Math.cos((location.lon - view.lon) * RADIANS);
    // projection(point) alone does not apply hemisphere clipping.
    if (facing <= 0.012) return null;
    const point = projection([location.lon, location.lat]);
    if (!point || point[0] < -margin || point[0] > width + margin || point[1] < -margin || point[1] > height + margin) return null;
    return { station, x: point[0], y: point[1] };
  }

  function draw(now) {
    frame = 0;
    if (destroyed) return;
    advanceRelease(now);
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

    // One atmospheric ring; no texture downloads or shaders.
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
    for (const group of groups) {
      const point = projectedStation(group.station, pinRadius + 5);
      if (!point) continue;
      visiblePins.push({...point, radius:pinRadius});
      circle(point.x, point.y, pinRadius);
    }
    context.fillStyle = palette.pin;
    context.globalAlpha = 0.88;
    context.fill();
    context.globalAlpha = 1;

    for (const station of [hovered, selected]) {
      if (!station||stationStreams.get(station.id)!==station.url) continue;
      const location = getMapLocation(station);
      const group = location && locationGroups.get(locationKey(location));
      if (!group) continue;
      const point = projectedStation(station, pinRadius + 5);
      if (!point) continue;
      const isSelected = station === selected;
      context.beginPath();
      circle(point.x, point.y, isSelected ? 10 : 7);
      context.lineWidth = isSelected ? 1.7 : 1;
      context.strokeStyle = isSelected ? palette.selected : palette.pin;
      context.stroke();
    }

    if (viewChanged) {
      viewChanged = false;
      onViewChange({ ...view, zoom, maxZoom: MAX_ZOOM });
    }
    if (release) invalidate(true);
  }

  function localPoint(event) {
    const bounds = canvas.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  function insideSphere(point) {
    return Math.hypot(point.x - width / 2, point.y - height / 2) <= radius + 6;
  }

  function hitTest(point, tolerance = 7) {
    // Prefer an exact dot hit before applying extra pointer tolerance.
    if (Number.isFinite(tolerance)) {
      for (let i = visiblePins.length - 1; i >= 0; i--) {
        const pin = visiblePins[i];
        if (!isMappable(pin.station)) continue;
        const distance = (point.x - pin.x) ** 2 + (point.y - pin.y) ** 2;
        if (distance <= pin.radius ** 2) return pin.station;
      }
    }
    let closest = null;
    let distanceSquared = tolerance * tolerance;
    for (const pin of visiblePins) {
      if (!isMappable(pin.station)) continue;
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

  function startGesture(moved = false, time = performance.now()) {
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
      canRotate: points.some(insideSphere),
      started: time,
      samples: [{ ...view, time }],
    };
  }

  function pointerDown(event) {
    canvas.classList.remove('keyboard-focus');
    if (event.button !== 0) return;
    const point = localPoint(event);
    stopRelease();
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, point);
    startGesture(pointers.size > 1, event.timeStamp);
    hover(null);
    canvas.style.cursor = 'grabbing';
  }

  function pointerMove(event) {
    const point = localPoint(event);
    if (!pointers.has(event.pointerId)) {
      const target = hitTest(point, insideSphere(point) ? 7 : 0);
      hover(target);
      canvas.style.cursor = target ? 'pointer' : 'grab';
      return;
    }
    pointers.set(event.pointerId, point);
    const points = [...pointers.values()];
    if (points.length > 1 && gesture.distance > 0) {
      gesture.moved = true;
      if (!gesture.canRotate) return;
      const distance = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
      zoom = clamp(gesture.zoom * distance / gesture.distance, 0.8, MAX_ZOOM);
      gesture.moved = true;
      invalidate(true);
      return;
    }
    const dx = point.x - gesture.x;
    const dy = point.y - gesture.y;
    if (Math.hypot(dx, dy) > 5) gesture.moved = true;
    if (!gesture.moved || !gesture.canRotate) return;
    const sensitivity = 75 / radius;
    const longitude = gesture.view.lon - dx * sensitivity;
    view.lon = wrapLongitude(longitude);
    view.lat = clamp(gesture.view.lat + dy * sensitivity, -89.5, 89.5);
    gesture.samples.push({ lon: longitude, lat: view.lat, time: event.timeStamp });
    gesture.samples = gesture.samples.filter(sample => event.timeStamp - sample.time <= 100);
    invalidate(true);
  }

  function pointerEnd(event) {
    if (!pointers.has(event.pointerId)) return;
    const shouldSelect = event.type === 'pointerup' && pointers.size === 1 && !gesture?.moved;
    const finishedGesture = gesture;
    const shouldRelease = event.type === 'pointerup' && pointers.size === 1;
    pointers.delete(event.pointerId);
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    startGesture(true, event.timeStamp);
    if (shouldRelease) beginRelease(event, finishedGesture);
    canvas.style.cursor = pointers.size ? 'grabbing' : 'grab';
    if (shouldSelect) {
      const station = hitTest(localPoint(event), event.pointerType === 'touch' ? 10 : 7);
      if (station) onSelect(station);
      else if (event.timeStamp - finishedGesture.started <= 450) onBackgroundTap();
    }
  }

  function zoomBy(factor) {
    if (!Number.isFinite(factor) || factor <= 0) return;
    stopRelease();
    zoom = clamp(zoom * factor, 0.8, MAX_ZOOM);
    hover(null);
    invalidate(true);
  }

  function keyDown(event) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', '_', 'Enter', ' '].includes(event.key)) stopRelease();
    const step = (event.shiftKey ? 15 : 6) / zoom;
    if (event.key === 'ArrowLeft') view.lon = wrapLongitude(view.lon - step);
    else if (event.key === 'ArrowRight') view.lon = wrapLongitude(view.lon + step);
    else if (event.key === 'ArrowUp') view.lat = clamp(view.lat + step, -89.5, 89.5);
    else if (event.key === 'ArrowDown') view.lat = clamp(view.lat - step, -89.5, 89.5);
    else if (event.key === '+' || event.key === '=') zoomBy(1.2);
    else if (event.key === '-' || event.key === '_') zoomBy(1 / 1.2);
    else if (event.key === 'Home') animateView(INITIAL_VIEW, 1);
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
  reducedMotion.addEventListener('change', () => {
    if (reducedMotion.matches) stopRelease(true);
  }, { signal: lifetime.signal });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopRelease(true);
  }, { signal: lifetime.signal });
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
      locationGroups = new Map();
      stationStreams = new Map();
      for (const station of Array.isArray(nextStations) ? nextStations : []) {
        const location = getMapLocation(station);
        if (!location) continue;
        const key = locationKey(location);
        const group = locationGroups.get(key);
        if (group) group.count++;
        else locationGroups.set(key, {station, count:1});
        stationStreams.set(station.id,station.url);
      }
      // Shared locations remain one dot, with every station available in the list.
      groups = [...locationGroups.values()].sort((a, b) => a.count - b.count);
      // Discard old hit targets immediately when a filter changes, before redraw.
      visiblePins = [];
      hover(null);
      invalidate();
    },
    selectStation(station) {
      selected = isMappable(station) ? station : null;
      invalidate();
    },
    focusStation(station) {
      const location = getMapLocation(station);
      if (!location) return;
      animateView(location);
    },
    zoomBy,
    reset() {
      animateView(INITIAL_VIEW, 1);
    },
    destroy() {
      stopRelease();
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
