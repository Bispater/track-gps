// =============================================================
// track-history.js · historial de recorrido por vehículo
// =============================================================
// GET /api/vehicles/:id/track?from=ISO&to=ISO
//   Lee el histórico de posiciones desde fm-track (paginado por continuation_token),
//   lo analiza (track-analysis.js) y devuelve ruta + viajes + paradas + resumen.
//   No persiste nada: fm-track es la fuente de verdad del histórico.
//
// Límites:
//   - rango máximo TRACK_HISTORY_MAX_DAYS (default 7) por consulta
//   - hasta MAX_PAGES páginas de PAGE_LIMIT puntos (si se supera, truncated=true)
//   - cache en RAM de CACHE_TTL_MS por (vehículo, from, to) para no repetir llamadas
import { analyzeTrack, normalizePoints } from './track-analysis.js';

const PAGE_LIMIT = 1000;
const MAX_PAGES = 40;
const MAX_DAYS = Math.max(1, Number(process.env.TRACK_HISTORY_MAX_DAYS || 7));
const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX = 100;
const cache = new Map();

function parseDate(v) {
  if (!v || typeof v !== 'string') return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
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
    const r = await callFmTrack(`/objects/${encodeURIComponent(objectId)}/coordinates?${qs.toString()}`, apiKey);
    if (!r.ok) {
      const detail = typeof r.data === 'object' && r.data ? (r.data.message || r.data.error || '') : String(r.data || '');
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

export function registerTrackRoutes(app, deps) {
  const { resolveApiKey } = deps;

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

    try {
      const apiKey = await resolveApiKey(id);
      const t0 = Date.now();
      const { items, truncated, pages } = await fetchCoordinates(id, from, to, apiKey, deps);
      const points = normalizePoints(items);
      const { summary, trips, stops, path } = analyzeTrack(points);
      const body = {
        vehicleId: id,
        from: from.toISOString(),
        to: to.toISOString(),
        pointsTotal: points.length,
        truncated,
        pages,
        elapsedMs: Date.now() - t0,
        summary, trips, stops, path,
      };
      cache.set(key, { at: Date.now(), body });
      if (cache.size > CACHE_MAX) {
        // Purga las entradas más antiguas
        const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, cache.size - CACHE_MAX);
        for (const [k] of oldest) cache.delete(k);
      }
      res.json(body);
    } catch (err) {
      res.status(502).json({ error: String(err?.message || err) });
    }
  });
}
