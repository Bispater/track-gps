// =============================================================
// routes.js · rutas generales (no ligadas a un destino)
// =============================================================
import { FM_TRACK_BASE_URL, FM_TRACK_API_KEY, TARGET_API_URL, TARGET_API_KEY, isGroupAllowed } from './config.js';
import * as db from './db.js';
import { callFmTrack, ensurePositions, ensureGroupsCache, positionsCache, groupsCache, groupApiKey, getFmTrackStats } from './fmtrack.js';
import { isStatsReady, getErrorsUntil } from './maintenance.js';
import { readBody } from './util.js';

const noFmKey = (res) => res.status(500).json({ error: 'FM_TRACK_API_KEY no configurada' });

export function registerCoreRoutes(app) {
  app.get('/api/config', (_req, res) => {
    res.json({
      fmTrackBaseUrl: FM_TRACK_BASE_URL,
      fmTrackKeyConfigured: Boolean(FM_TRACK_API_KEY),
      targetApiUrl: TARGET_API_URL,
      targetKeyConfigured: Boolean(TARGET_API_KEY),
    });
  });

  // ---------- fm-track ----------
  // Proxy de lectura: /api/fm-track?path=/objects
  app.get('/api/fm-track', async (req, res) => {
    const relPath = req.query.path;
    if (!relPath || typeof relPath !== 'string') return res.status(400).json({ error: 'Falta ?path=' });
    if (!FM_TRACK_API_KEY) return noFmKey(res);
    try {
      const r = await callFmTrack(relPath);
      await db.appendActivity({ kind: 'fetch', path: relPath, status: r.status, ok: r.ok });
      res.status(r.status).json(r);
    } catch (err) {
      await db.appendActivity({ kind: 'fetch_error', path: relPath, error: String(err) });
      res.status(502).json({ error: String(err) });
    }
  });

  // Diagnóstico: consultas a fm-track por minuto (total, por tipo, 429) y estado del recolector
  app.get('/api/fm-track/stats', (_req, res) => res.json(getFmTrackStats()));

  // Vehículos + últimas posiciones + grupos de todos los tenants (de RAM: no consulta fm-track)
  app.get('/api/snapshot', async (_req, res) => {
    if (!FM_TRACK_API_KEY) return noFmKey(res);
    try {
      await Promise.all([ensurePositions(), ensureGroupsCache()]);
      res.json({
        objects: { ok: true, status: 200, data: positionsCache.objects },
        positions: { ok: true, status: 200, data: Array.from(positionsCache.byId.values()) },
        groups: { ok: true, status: 200, data: groupsCache.groups },
      });
    } catch (err) { res.status(502).json({ error: String(err) }); }
  });

  // Grupos pre-armados en fm-track (cada uno con sus objects_ids), filtrados por ALLOWED_GROUPS
  app.get('/api/fm-track/groups', async (_req, res) => {
    if (!FM_TRACK_API_KEY) return noFmKey(res);
    try {
      await ensureGroupsCache();
      res.json({ groups: groupsCache.groups.filter(isGroupAllowed) });
    } catch (err) { res.status(502).json({ error: String(err) }); }
  });

  app.get('/api/fm-track/groups/:id', async (req, res) => {
    if (!FM_TRACK_API_KEY) return noFmKey(res);
    try {
      await ensureGroupsCache();
      const id = req.params.id;
      const r = await callFmTrack('/object-groups/' + encodeURIComponent(id), groupApiKey(id));
      res.status(r.status).json(r);
    } catch (err) { res.status(502).json({ error: String(err) }); }
  });

  // ---------- reenvío genérico a TARGET_API_URL ----------
  app.post('/api/forward', async (req, res) => {
    const { payload, urlOverride, method = 'POST', headers: extra = {} } = req.body ?? {};
    const targetUrl = urlOverride || TARGET_API_URL;
    if (!targetUrl) return res.status(400).json({ error: 'No hay TARGET_API_URL ni urlOverride' });
    try {
      const headers = {
        'Content-Type': 'application/json', Accept: 'application/json',
        ...(TARGET_API_KEY ? { Authorization: `Bearer ${TARGET_API_KEY}` } : {}),
        ...extra,
      };
      const r = await fetch(targetUrl, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(payload ?? {}) });
      const body = await readBody(r);
      await db.appendActivity({ kind: 'forward_generic', targetUrl, method, status: r.status, ok: r.ok });
      res.json({ ok: r.ok, status: r.status, response: body });
    } catch (err) { res.status(502).json({ error: String(err) }); }
  });

  app.get('/api/logs', async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 1000);
    res.json({ entries: await db.getActivity(limit) });
  });

  // ---------- métricas (dashboard) ----------
  // Cache corto: la pantalla de Métricas se refresca sola cada 60 s y varios usuarios
  // pueden tenerla abierta; los agregados se recalculan cada minuto de todas formas.
  const statsCache = new Map(); // "horas|cliente" → { at, body }
  const STATS_HOURS = new Set([24, 48, 168]);
  app.get('/api/stats/sends', async (req, res) => {
    try {
      const hoursRaw = Number(req.query.hours) || 24;
      const hours = STATS_HOURS.has(hoursRaw) ? hoursRaw : 24;
      // ?client=<id>: solo ese cliente (sin el parámetro = todos)
      const client = typeof req.query.client === 'string' && /^[a-z0-9_-]{1,40}$/i.test(req.query.client) ? req.query.client : null;
      const key = `${hours}|${client || ''}`;
      const hit = statsCache.get(key);
      if (hit && Date.now() - hit.at < 30 * 1000) return res.json(hit.body);
      const body = { ...(await db.getSendStats({ hours, client, errorsUntil: getErrorsUntil() })), ready: isStatsReady() };
      statsCache.set(key, { at: Date.now(), body });
      res.json(body);
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });
}
