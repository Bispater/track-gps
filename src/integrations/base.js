// =============================================================
// integrations/base.js · lo que todos los destinos GPS tienen igual
// =============================================================
// Cada destino (Falabella, Wise, …) define solo lo propio: cómo arma el payload, cómo lo
// envía y cómo interpreta la respuesta. defineIntegration() le agrega:
//   - config de envío por grupo fm-track (intervalo, auto-envío), persistida en group_config
//   - rutas /api/<key>/config · groups · groups/:id (PUT/DELETE) · preview · send-one ·
//     groups/:id/send · history
//   - scheduler: cada tickMs revisa qué grupos activos toca enviar
//
// spec:
//   key, label           prefijo de rutas / cliente en la base, y nombre para logs
//   groups               whitelist de grupos fm-track (valor de <CLIENTE>_GROUPS)
//   intervalSec          intervalo por defecto; minIntervalSec = piso al editarlo
//   groupDefaults()      campos extra de la config por grupo (ej. env, x_country)
//   tickMs               cada cuánto revisa el scheduler (default 2 s)
//   config()             respuesta de GET /config
//   preview(obj, pos, body)               payload que se enviaría (sin enviar)
//   send({ groupId, vehicleIds, ... })    envía y devuelve una entrada de historial por vehículo
//   sendOptions(body)    opciones extra que send-one / groups/:id/send toman del body
//   updateGroup(body, next)  aplica campos extra del PUT; si devuelve un string, es un 400
//   init()               carga de estado propio al arrancar (ej. bloqueados)
//   routes(app)          rutas propias adicionales
//   warnings()           avisos al arrancar (credenciales faltantes, etc.)
import * as db from '../db.js';
import { groupFilter } from '../config.js';
import { ensureGroupsCache, groupsCache, getPositionsForId } from '../fmtrack.js';

export const NO_POSITION = 'sin posición en últimos 7 días';

export function defineIntegration(spec) {
  const {
    key, label, intervalSec, minIntervalSec, tickMs = 2000,
    groupDefaults = () => ({}), sendOptions = () => ({}),
  } = spec;
  const isGroupAllowed = groupFilter(spec.groups);
  let groups = {}; // groupId → config de envío (solo los grupos que alguna vez se configuraron)

  const defaults = () => ({
    intervalSec, enabled: false, ...groupDefaults(),
    lastRunAt: null, lastStatus: null, lastSummary: null,
  });
  const saveGroups = () => db.saveGroupConfigs(key, groups);

  function registerRoutes(app) {
    const base = `/api/${key}`;

    app.get(`${base}/config`, (_req, res) => res.json(spec.config()));

    // Grupos de fm-track (según la whitelist) mezclados con la config local de envío
    app.get(`${base}/groups`, async (_req, res) => {
      try {
        await ensureGroupsCache();
        const out = {};
        for (const g of groupsCache.groups) {
          if (!isGroupAllowed(g)) continue;
          out[g.id] = { id: g.id, name: g.name, vehicles: g.vehicles || [], ...defaults(), ...(groups[g.id] || {}) };
        }
        res.json({ groups: out });
      } catch (err) { res.status(500).json({ error: String(err) }); }
    });

    app.put(`${base}/groups/:id`, async (req, res) => {
      const id = String(req.params.id);
      const body = req.body || {};
      const next = { ...(groups[id] || defaults()) };
      if (body.intervalSec != null) next.intervalSec = Math.max(minIntervalSec, Number(body.intervalSec) || intervalSec);
      if (body.enabled != null) next.enabled = Boolean(body.enabled);
      const error = spec.updateGroup?.(body, next);
      if (error) return res.status(400).json({ error });
      groups[id] = next;
      await saveGroups();
      res.json(next);
    });

    // Vuelve la config a los defaults (la lista de vehículos viene siempre de fm-track)
    app.delete(`${base}/groups/:id`, async (req, res) => {
      const id = String(req.params.id);
      delete groups[id];
      await db.deleteGroupConfig(key, id);
      res.json({ ok: true });
    });

    app.post(`${base}/preview`, async (req, res) => {
      try {
        const body = req.body ?? {};
        if (!body.vehicleId) return res.status(400).json({ ok: false, error: 'falta vehicleId' });
        const { obj, pos } = await getPositionsForId(body.vehicleId);
        if (!pos) return res.json({ ok: false, error: 'sin última posición' });
        res.json({ ok: true, payload: await spec.preview(obj, pos, body), raw: { object: obj, position: pos } });
      } catch (err) { res.status(500).json({ ok: false, error: String(err) }); }
    });

    app.post(`${base}/send-one`, async (req, res) => {
      try {
        const body = req.body ?? {};
        if (!body.vehicleId) return res.status(400).json({ error: 'falta vehicleId' });
        const [r] = await spec.send({ ...sendOptions(body), vehicleIds: [body.vehicleId], groupId: body.groupId });
        res.json(r);
      } catch (err) { res.status(500).json({ error: String(err) }); }
    });

    app.post(`${base}/groups/:id/send`, async (req, res) => {
      try {
        const results = await spec.send({ ...sendOptions(req.body ?? {}), groupId: req.params.id });
        res.json({ results });
      } catch (err) { res.status(500).json({ error: String(err) }); }
    });

    app.get(`${base}/history`, async (req, res) => {
      const limit = Math.min(Number(req.query.limit) || 200, 1000);
      const groupId = req.query.groupId ? String(req.query.groupId) : null;
      res.json({ entries: await db.getHistory(key, { limit, groupId }) });
    });

    spec.routes?.(app);
  }

  // Envío automático: dispara cada grupo activo cuando pasó su intervalo
  function startScheduler() {
    setInterval(async () => {
      try { await ensureGroupsCache(); } catch { return; }
      const now = Date.now();
      for (const fmGroup of groupsCache.groups) {
        if (!isGroupAllowed(fmGroup)) continue;
        const config = groups[fmGroup.id];
        if (!config?.enabled) continue;
        if (!fmGroup.vehicles?.length) continue;
        const last = config.lastRunAt ? new Date(config.lastRunAt).getTime() : 0;
        if (now - last < (config.intervalSec || intervalSec) * 1000) continue;
        // Marca antes de enviar para evitar disparos paralelos
        config.lastRunAt = new Date().toISOString();
        try {
          const results = await spec.send({ groupId: fmGroup.id });
          const accepted = results.filter((x) => x.accepted).length;
          const okCount = results.filter((x) => x.ok).length;
          const failed = results.filter((x) => !x.ok).length;
          config.lastSummary = { total: results.length, accepted, ok: okCount, failed };
          config.lastStatus = failed === 0 ? (accepted === results.length ? 'ok' : 'partial') : 'err';
        } catch (err) {
          config.lastStatus = 'err';
          config.lastSummary = { error: String(err) };
          await db.appendActivity({ kind: `${key}_scheduler_error`, groupId: fmGroup.id, error: String(err) });
        }
        await saveGroups();
      }
    }, tickMs);
  }

  return {
    key, label,
    get groups() { return groups; },
    appendHistory: (entry) => db.appendHistory(key, entry),
    async init() {
      groups = await db.loadGroupConfigs(key);
      await spec.init?.();
    },
    registerRoutes,
    startScheduler,
    warnings: () => spec.warnings?.() || [],
    activeSummary: () => `${Object.values(groups).filter((g) => g.enabled).length}/${Object.keys(groups).length}`,
  };
}

// Recorre los vehículos en orden con su última posición de fm-track. Los que no tienen
// posición o fallan quedan como error en el historial y no llegan a `handle`.
// `handle({ vehicleId, obj, pos })` devuelve la entrada de historial del vehículo, o nada si
// lo deja para un envío por lote que se hace después.
//   skip(vehicleId)  → entrada para registrar sin consultar la posición (ej. bloqueado)
//   stopWhen()       → true para cortar el recorrido (ej. tope de posiciones por request)
export async function eachVehicle(ids, opts, handle) {
  const { groupId, append, noPosition = NO_POSITION, noPositionExtra = {}, skip, stopWhen } = opts;
  const results = [];
  const record = async (entry) => { await append(entry); results.push(entry); };
  for (const vehicleId of ids) {
    const skipped = skip?.(vehicleId);
    if (skipped) { await record(skipped); continue; }
    try {
      const { obj, pos } = await getPositionsForId(vehicleId);
      if (!pos) {
        await record({ vehicleId, ok: false, accepted: false, error: noPosition, groupId, ...noPositionExtra });
        continue;
      }
      const entry = await handle({ vehicleId, obj, pos });
      if (entry) await record(entry);
    } catch (err) {
      await record({ vehicleId, ok: false, accepted: false, error: String(err), groupId });
    }
    if (stopWhen?.()) break;
  }
  return results;
}
