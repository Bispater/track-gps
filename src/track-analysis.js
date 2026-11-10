// =============================================================
// track-analysis.js · análisis de recorridos (puro, sin I/O)
// =============================================================
// Recibe los items crudos de fm-track (/objects/{id}/coordinates) y entrega:
//   - points  : puntos normalizados y ordenados por tiempo
//   - summary : km recorridos, tiempo en movimiento/detenido, velocidades
//   - trips   : viajes (tramos en movimiento entre paradas)
//   - stops   : paradas (>= stopMinSec sin desplazamiento)
//   - path    : polilínea simplificada para dibujar [[lat, lng, tSec, speed], ...]
//
// Heurísticas (ajustables vía opts):
//   - Un tramo entre dos puntos consecutivos es "en movimiento" si se desplazó
//     >= stationaryRadiusKm, o si en < 5 min reportó velocidad > stationarySpeedKmh
//     y se movió más de 20 m (evita el jitter GPS de un camión estacionado).
//   - Saltos imposibles (> glitchKmh implícitos y > 1 km) se descartan como error GPS.
//   - Paradas: corridas estacionarias de al menos stopMinSec. Las más cortas
//     (semáforos, peajes) se funden dentro del viaje.
//   - Un desplazamiento < tripMinKm entre dos paradas (acomodar el camión en un
//     patio) no es un viaje: se funde con las paradas vecinas en una sola.
//   - Si el equipo deja de reportar estando quieto (muy común con motor apagado),
//     el hueco entre reportes cuenta como parada.

export const DEFAULTS = {
  stopMinSec: 300,          // 5 min quieto = parada
  tripMinKm: 0.5,           // un desplazamiento menor entre dos paradas es una maniobra, no un viaje
  stationarySpeedKmh: 3,    // bajo esto se considera detenido
  stationaryRadiusKm: 0.15, // desplazamiento mínimo para contar movimiento
  glitchKmh: 180,           // velocidad implícita imposible → salto GPS
  maxPathPoints: 6000,      // tope de puntos de la polilínea simplificada
  simplifyTolDeg: 0.00003,  // ~3 m · tolerancia Douglas-Peucker
};

const toIso = (ms) => new Date(ms).toISOString();
const r3 = (n) => Math.round(n * 1000) / 1000;
const r6 = (n) => Math.round(n * 1e6) / 1e6;

export function haversineKm(a, b) {
  const R = 6371.0088;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// fm-track items → puntos normalizados, ordenados asc por tiempo y sin duplicados.
export function normalizePoints(items) {
  const out = [];
  for (const it of items || []) {
    const pos = it?.position || {};
    const lat = Number(pos.latitude);
    const lng = Number(pos.longitude);
    const t = Date.parse(it?.datetime);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(t)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) continue;
    const speed = Number(pos.speed);
    const dir = Number(pos.direction);
    const odo = Number(it?.calculated_inputs?.mileage);
    const ignRaw = it?.ignition_status;
    out.push({
      t, lat, lng,
      speed: Number.isFinite(speed) && speed >= 0 ? speed : 0,
      dir: Number.isFinite(dir) ? dir : null,
      ign: ignRaw === 'ON' ? 1 : ignRaw === 'OFF' ? 0 : null,
      odo: Number.isFinite(odo) ? odo : null,
    });
  }
  out.sort((a, b) => a.t - b.t);
  const dedup = [];
  for (const p of out) {
    if (!dedup.length || dedup[dedup.length - 1].t !== p.t) dedup.push(p);
  }
  return dedup;
}

// Douglas-Peucker iterativo sobre lat/lng (aprox. planar, suficiente para tramos cortos).
export function simplifyPath(pts, tolDeg) {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1; keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  const tol2 = tolDeg * tolDeg;
  while (stack.length) {
    const [s, e] = stack.pop();
    if (e - s < 2) continue;
    const ax = pts[s].lng, ay = pts[s].lat, bx = pts[e].lng, by = pts[e].lat;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1, maxI = -1;
    for (let i = s + 1; i < e; i++) {
      const px = pts[i].lng, py = pts[i].lat;
      let d2;
      if (len2 === 0) {
        d2 = (px - ax) ** 2 + (py - ay) ** 2;
      } else {
        let u = ((px - ax) * dx + (py - ay) * dy) / len2;
        u = Math.max(0, Math.min(1, u));
        d2 = (px - (ax + u * dx)) ** 2 + (py - (ay + u * dy)) ** 2;
      }
      if (d2 > maxD) { maxD = d2; maxI = i; }
    }
    if (maxD > tol2) {
      keep[maxI] = 1;
      stack.push([s, maxI], [maxI, e]);
    }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

function centroid(pts) {
  let lat = 0, lng = 0;
  for (const p of pts) { lat += p.lat; lng += p.lng; }
  return { lat: r6(lat / pts.length), lng: r6(lng / pts.length) };
}

function mergeAdjacent(runs) {
  const out = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && last.moving === r.moving) {
      last.to = r.to; last.dtSec += r.dtSec; last.distKm += r.distKm; last.movSec += r.movSec;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

// Descarta "picos" GPS: puntos que implican una velocidad imposible respecto al
// último punto aceptado. Si se rechazan 3 seguidos, se acepta el siguiente
// (la referencia era la errónea, no los nuevos).
export function dropGlitches(points, glitchKmh = DEFAULTS.glitchKmh) {
  if (points.length < 2) return points.slice();
  const out = [points[0]];
  let rejected = 0;
  for (let i = 1; i < points.length; i++) {
    const ref = out[out.length - 1];
    const p = points[i];
    const dtH = (p.t - ref.t) / 3600000;
    const d = haversineKm(ref, p);
    if (d > 1 && dtH > 0 && d / dtH > glitchKmh && rejected < 3) { rejected++; continue; }
    rejected = 0;
    out.push(p);
  }
  return out;
}

export function analyzeTrack(rawPoints, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const points = dropGlitches(rawPoints, o.glitchKmh);
  const n = points.length;
  const summary = {
    distanceKm: 0, odometerKm: null, movingSec: 0, stoppedSec: 0,
    maxSpeed: 0, avgSpeed: 0, trips: 0, stops: 0,
    firstTs: n ? toIso(points[0].t) : null,
    lastTs: n ? toIso(points[n - 1].t) : null,
    points: n,
    glitches: rawPoints.length - n,
  };
  if (n === 0) return { summary, trips: [], stops: [], path: [] };
  if (n === 1) {
    const p = points[0];
    return { summary, trips: [], stops: [], path: [[r6(p.lat), r6(p.lng), Math.round(p.t / 1000), p.speed]] };
  }

  // 1) Segmentos entre puntos consecutivos
  let runs = [];
  for (let i = 0; i < n - 1; i++) {
    const a = points[i], b = points[i + 1];
    const dtSec = (b.t - a.t) / 1000;
    let distKm = haversineKm(a, b);
    const impliedKmh = dtSec > 0 ? distKm / (dtSec / 3600) : Infinity;
    const glitch = distKm > 1 && impliedKmh > o.glitchKmh;
    if (glitch) distKm = 0;
    const moving = !glitch && (
      distKm >= o.stationaryRadiusKm ||
      (dtSec < 300 && distKm > 0.02 && (a.speed > o.stationarySpeedKmh || b.speed > o.stationarySpeedKmh))
    );
    // Tiempo en movimiento: si hay un hueco largo sin reportes (sin cobertura) no
    // contamos todo el hueco como conducción; se estima a 40 km/h.
    let movSec = 0;
    if (moving) movSec = dtSec <= 1800 ? dtSec : Math.min(dtSec, Math.max(60, (distKm / 40) * 3600));
    runs.push({ moving, from: i, to: i + 1, dtSec, distKm, movSec });
  }
  runs = mergeAdjacent(runs);

  // 2) Jitter: "movimientos" minúsculos entre dos corridas quietas → quietos
  for (const r of runs) {
    if (r.moving && r.distKm < 0.1 && r.dtSec < 120) { r.moving = false; r.movSec = 0; }
  }
  runs = mergeAdjacent(runs);
  // 3) Paradas cortas (semáforo, peaje) → parte del viaje
  for (const r of runs) {
    if (!r.moving && r.dtSec < o.stopMinSec) { r.moving = true; r.movSec = r.dtSec; }
  }
  runs = mergeAdjacent(runs);
  // 4) Maniobras: movimiento corto entre dos paradas → se funde con ellas en una sola parada
  for (let i = 1; i < runs.length - 1; i++) {
    const r = runs[i];
    if (r.moving && r.distKm < o.tripMinKm && !runs[i - 1].moving && !runs[i + 1].moving) { r.moving = false; r.movSec = 0; }
  }
  runs = mergeAdjacent(runs);

  // 5) Viajes y paradas
  const trips = [];
  const stops = [];
  const path = [];
  const pushPath = (p) => {
    const row = [r6(p.lat), r6(p.lng), Math.round(p.t / 1000), p.speed];
    const last = path[path.length - 1];
    if (last && last[0] === row[0] && last[1] === row[1] && last[2] === row[2]) return;
    path.push(row);
  };

  let tol = o.simplifyTolDeg;
  // Las polilíneas por viaje se simplifican; si el total supera el tope, se sube la tolerancia.
  const buildPath = (tolDeg) => {
    path.length = 0;
    for (const r of runs) {
      const seg = points.slice(r.from, r.to + 1);
      if (r.moving) {
        for (const p of simplifyPath(seg, tolDeg)) pushPath(p);
      } else {
        const c = centroid(seg);
        pushPath({ ...c, t: seg[0].t, speed: 0 });
        pushPath({ ...c, t: seg[seg.length - 1].t, speed: 0 });
      }
    }
  };
  buildPath(tol);
  for (let k = 0; k < 4 && path.length > o.maxPathPoints; k++) { tol *= 2.5; buildPath(tol); }

  for (const r of runs) {
    const seg = points.slice(r.from, r.to + 1);
    const a = seg[0], b = seg[seg.length - 1];
    if (r.moving) {
      let maxSpeed = 0;
      for (const p of seg) if (p.speed <= 200) maxSpeed = Math.max(maxSpeed, p.speed);
      const odoOk = a.odo != null && b.odo != null && b.odo >= a.odo && (b.odo - a.odo) < 5000
        && (b.odo > a.odo || r.distKm < 0.5);
      trips.push({
        idx: trips.length,
        startTs: toIso(a.t), endTs: toIso(b.t),
        durationSec: Math.round(r.dtSec),
        movingSec: Math.round(r.movSec),
        distanceKm: r3(r.distKm),
        odometerKm: odoOk ? r3(b.odo - a.odo) : null,
        maxSpeed,
        avgSpeed: r.movSec > 0 ? Math.round((r.distKm / (r.movSec / 3600)) * 10) / 10 : 0,
        start: { lat: r6(a.lat), lng: r6(a.lng) },
        end: { lat: r6(b.lat), lng: r6(b.lng) },
        points: seg.length,
      });
    } else {
      const offCount = seg.filter((p) => p.ign === 0).length;
      const c = centroid(seg);
      stops.push({
        idx: stops.length,
        startTs: toIso(a.t), endTs: toIso(b.t),
        durationSec: Math.round(r.dtSec),
        lat: c.lat, lng: c.lng,
        ignitionOff: offCount > seg.length / 2,
        ongoing: r === runs[runs.length - 1],
        points: seg.length,
      });
    }
  }

  // 6) Resumen
  let maxSpeed = 0;
  for (const p of points) if (p.speed <= 200) maxSpeed = Math.max(maxSpeed, p.speed);
  const distanceKm = trips.reduce((s, t) => s + t.distanceKm, 0);
  const movingSec = trips.reduce((s, t) => s + t.movingSec, 0);
  const stoppedSec = stops.reduce((s, t) => s + t.durationSec, 0);
  const first = points[0], last = points[n - 1];
  // Odómetro válido solo si existe, no retrocede y realmente avanzó (un equipo que no
  // reporta kilometraje entrega el mismo valor siempre → mostrar 0 km sería engañoso).
  const odoOk = first.odo != null && last.odo != null && last.odo >= first.odo && (last.odo - first.odo) < 20000
    && (last.odo > first.odo || distanceKm < 0.5);
  Object.assign(summary, {
    distanceKm: r3(distanceKm),
    odometerKm: odoOk ? r3(last.odo - first.odo) : null,
    movingSec: Math.round(movingSec),
    stoppedSec: Math.round(stoppedSec),
    maxSpeed,
    avgSpeed: movingSec > 0 ? Math.round((distanceKm / (movingSec / 3600)) * 10) / 10 : 0,
    trips: trips.length,
    stops: stops.length,
  });
  return { summary, trips, stops, path };
}
