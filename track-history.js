// =============================================================
// track-history.js · historial de recorrido por vehículo
// =============================================================
// GET /api/vehicles/:id/track?from=ISO&to=ISO
//   1. Lee las posiciones desde Postgres (position_history), que se llena sola con lo
//      que el refresh de fm-track ya trae cada 10 s → cero llamadas extra a fm-track.
//   2. Si el rango pedido empieza antes de lo que hay guardado (días previos al deploy),
//      completa SOLO ese tramo desde fm-track una vez y lo guarda; la próxima vez sale local.
//   3. Analiza los puntos (track-analysis.js) → ruta + viajes + paradas + resumen.
//
// Límites:
//   - rango máximo TRACK_HISTORY_MAX_DAYS (default 7) por consulta
//   - relleno desde fm-track: hasta MAX_PAGES páginas de PAGE_LIMIT puntos (truncated=true si se supera)
//   - 429 de fm-track: reintenta con espera creciente
//   - cache en RAM de CACHE_TTL_MS por (vehículo, from, to)
import { analyzeTrack, normalizePoints } from './track-analysis.js';

const PAGE_LIMIT = 1000;
const MAX_PAGES = 40;
const MAX_DAYS = Math.max(1, Number(process.env.TRACK_HISTORY_MAX_DAYS || 7));
const FALLBACK = String(process.env.TRACK_HISTORY_FALLBACK ?? 'true').toLowerCase() !== 'false';
const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX = 100;
const RETRY_429 = [1500, 3000, 6000];
const cache = new Map();
const backfilledFrom = new Map(); // vehicleId → epoch ms: ya se pidió a fm-track desde aquí (evita repetir rangos vacíos)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ejecuta fn sobre items con a lo más `limit` promesas en vuelo. Misma forma que Promise.allSettled.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      try { results[i] = { status: 'fulfilled', value: await fn(items[i], i) }; }
      catch (reason) { results[i] = { status: 'rejected', reason }; }
    }
  });
  await Promise.all(workers);
  return results;
}

function parseDate(v) {
  if (!v || typeof v !== 'string') return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
function errorDetail(data) {
  if (data && typeof data === 'object') return String(data.message || data.error || '');
  // nginx devuelve HTML en los 429/5xx: dejar solo el texto
  return String(data || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

async function fetchCoordinates(objectId, from, to, apiKey, { callFmTrack, toArray }) {
  const items = [];
  let token = null;
  let pages = 0;
  for (;;) {
    const qs = new URLSearchParams({
      fromDatetime: from.toISOString(),
      toDatetime: to.toISOString(),
      limit: String(PAGE_LIMIT),
    });
    if (token) qs.set('continuationToken', token);
    const path = `/objects/${encodeURIComponent(objectId)}/coordinates?${qs.toString()}`;
    let r;
    for (let attempt = 0; ; attempt++) {
      r = await callFmTrack(path, apiKey);
      if (r.status !== 429 || attempt >= RETRY_429.length) break;
      await sleep(RETRY_429[attempt]);
    }
    if (!r.ok) {
      const detail = errorDetail(r.data);
      throw new Error(`fm-track coordinates → HTTP ${r.status}${detail ? ' · ' + detail : ''}`);
    }
    const page = toArray(r.data?.items ?? r.data);
    items.push(...page);
    pages++;
    const next = r.data?.continuation_token ?? r.data?.continuationToken ?? null;
    if (!next || !page.length || String(next) === token) return { items, truncated: false, pages };
    if (pages >= MAX_PAGES) return { items, truncated: true, pages };
    token = String(next);
  }
}

function mergePoints(a, b) {
  const byT = new Map();
  for (const p of a) byT.set(p.t, p);
  for (const p of b) if (!byT.has(p.t)) byT.set(p.t, p);
  return [...byT.values()].sort((x, y) => x.t - y.t);
}

export function registerTrackRoutes(app, deps) {
  const { resolveApiKey, db } = deps;

  app.get('/api/vehicles/:id/track', async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Falta id de vehículo' });

    const now = new Date();
    let to = parseDate(req.query.to) || now;
    if (to > now) to = now;
    const from = parseDate(req.query.from) || new Date(to.getTime() - 24 * 3600 * 1000);
    if (from >= to) return res.status(400).json({ error: 'Rango inválido: from debe ser anterior a to' });
    if (to.getTime() - from.getTime() > MAX_DAYS * 24 * 3600 * 1000) {
      return res.status(400).json({ error: `Rango máximo ${MAX_DAYS} días por consulta` });
    }

    const key = `${id}|${from.toISOString()}|${to.toISOString()}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return res.json(hit.body);

    const t0 = Date.now();
    try {
      // 1) Base local
      let points = await db.getPositions(id, from, to);
      const localCount = points.length;
      let fetchedFm = 0;
      let truncated = false;
      let pages = 0;

      // 2) Relleno del tramo inicial sin cobertura local (una sola vez por vehículo y rango)
      if (FALLBACK) {
        const cov = await db.getPositionCoverage(id);
        const already = backfilledFrom.get(id) ?? Infinity;
        const coveredFrom = Math.min(cov.first ? cov.first.getTime() : Infinity, already);
        const headEnd = new Date(Math.min(coveredFrom, to.getTime()));
        if (headEnd.getTime() - from.getTime() > 2 * 60 * 1000) {
          const apiKey = await resolveApiKey(id);
          const r = await fetchCoordinates(id, from, headEnd, apiKey, deps);
          const fmPts = normalizePoints(r.items);
          truncated = r.truncated;
          pages = r.pages;
          fetchedFm = fmPts.length;
          if (fmPts.length) await db.insertPositions(id, fmPts);
          if (!r.truncated) backfilledFrom.set(id, Math.min(already, from.getTime()));
          points = mergePoints(points, fmPts);
        }
      }

      const { summary, trips, stops, path } = analyzeTrack(points);
      const body = {
        vehicleId: id,
        from: from.toISOString(),
        to: to.toISOString(),
        pointsTotal: points.length,
        source: fetchedFm ? (localCount ? 'mixto' : 'fm-track') : 'local',
        localCount, fetchedFm,
        truncated, pages,
        elapsedMs: Date.now() - t0,
        summary, trips, stops, path,
      };
      cache.set(key, { at: Date.now(), body });
      if (cache.size > CACHE_MAX) {
        const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, cache.size - CACHE_MAX);
        for (const [k] of oldest) cache.delete(k);
      }
      res.json(body);
    } catch (err) {
      res.status(502).json({ error: String(err?.message || err) });
    }
  });
}
