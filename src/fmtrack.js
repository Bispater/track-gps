// =============================================================
// fmtrack.js · cliente fm-track (fuente de los datos GPS) + caches en RAM
// =============================================================
// Multi-tenant: una API key por tenant. Cada tenant tiene su cache de vehículos/posiciones
// (TTL 10 s) y de grupos (TTL 30 s). Cada refresh trae los últimos 60 min de cada vehículo
// y lo nuevo se guarda en Postgres (position_history) para el historial del mapa.
import { FM_TRACK_BASE_URL, FM_TRACK_VERSION, FM_TRACK_API_KEY, FM_TRACK_API_KEYS, env } from './config.js';
import * as db from './db.js';
import { normalizePoints } from './track-analysis.js';
import { toArray, pick, readBody, mapLimit } from './util.js';

const POSITIONS_TTL_MS = 10000;
const COORDS_LOOKBACK_MIN = 60;
const GROUPS_TTL_MS = 30000;
// Llamadas simultáneas a fm-track al refrescar posiciones. Antes salían las ~90 a la vez
// y fm-track respondía 429 Too Many Requests a lo que llegara en ese instante.
const FM_TRACK_CONCURRENCY = Math.max(1, Number(env.FM_TRACK_CONCURRENCY || 8));

// ---------- HTTP ----------
function buildFmTrackUrl(relPath, apiKey = FM_TRACK_API_KEY) {
  const slash = relPath.startsWith('/') ? '' : '/';
  const url = new URL(`${FM_TRACK_BASE_URL.replace(/\/$/, '')}${slash}${relPath}`);
  if (!url.searchParams.has('version')) url.searchParams.set('version', FM_TRACK_VERSION);
  url.searchParams.set('api_key', apiKey);
  return url.toString();
}
export async function callFmTrack(relPath, apiKey = FM_TRACK_API_KEY) {
  const upstream = await fetch(buildFmTrackUrl(relPath, apiKey), {
    headers: { Accept: 'application/json', 'X-Api-Key': apiKey },
  });
  return { status: upstream.status, ok: upstream.ok, data: await readBody(upstream) };
}

// ---------- caches por tenant ----------
const positionsCachesByKey = new Map();   // apiKey → { fetchedAt, byId, objects }
const groupsCachesByKey = new Map();      // apiKey → { fetchedAt, groups }
const vehicleKeyIndex = new Map();        // vehicleId → apiKey (qué tenant tiene este vehículo)
const groupKeyIndex = new Map();          // groupId → apiKey (qué tenant tiene este grupo)

function getPositionsCacheFor(apiKey) {
  if (!positionsCachesByKey.has(apiKey)) {
    positionsCachesByKey.set(apiKey, { fetchedAt: 0, byId: new Map(), objects: [] });
  }
  return positionsCachesByKey.get(apiKey);
}
function getGroupsCacheFor(apiKey) {
  if (!groupsCachesByKey.has(apiKey)) {
    groupsCachesByKey.set(apiKey, { fetchedAt: 0, groups: [] });
  }
  return groupsCachesByKey.get(apiKey);
}

// Vista agregada: unión de los caches de todos los tenants.
export const positionsCache = {
  get fetchedAt() {
    return Math.max(0, ...Array.from(positionsCachesByKey.values()).map((c) => c.fetchedAt));
  },
  get objects() {
    return Array.from(positionsCachesByKey.values()).flatMap((c) => c.objects);
  },
  get byId() {
    const all = new Map();
    for (const c of positionsCachesByKey.values()) {
      for (const [k, v] of c.byId.entries()) all.set(k, v);
    }
    return all;
  },
};
export const groupsCache = {
  get fetchedAt() {
    return Math.max(0, ...Array.from(groupsCachesByKey.values()).map((c) => c.fetchedAt));
  },
  get groups() {
    return Array.from(groupsCachesByKey.values()).flatMap((c) => c.groups);
  },
};

// ---------- grupos ----------
async function ensureGroupsCacheForKey(apiKey) {
  const cache = getGroupsCacheFor(apiKey);
  if (Date.now() - cache.fetchedAt < GROUPS_TTL_MS) return;
  try {
    const r = await callFmTrack('/object-groups', apiKey);
    if (!r.ok) {
      console.warn(`[fm-track] error al listar grupos: HTTP ${r.status}`);
      return;
    }
    const items = toArray(r.data?.items ?? r.data);
    cache.groups = items.map((g) => ({
      id: String(g.id), name: String(g.name || ''),
      vehicles: Array.isArray(g.objects_ids) ? g.objects_ids.map(String) : [],
    }));
    for (const g of cache.groups) groupKeyIndex.set(g.id, apiKey);
    cache.fetchedAt = Date.now();
    // Log de diagnóstico: solo cuando la lista cambia (nombre exacto = lo que va en *_GROUPS)
    const names = cache.groups.map((g) => `"${g.name}" (id ${g.id}, ${g.vehicles.length} veh)`).join(', ') || '(ninguno)';
    if (names !== cache.lastLoggedNames) {
      cache.lastLoggedNames = names;
      console.log(`[fm-track] grupos sincronizados: ${names}`);
    }
  } catch (err) {
    console.warn('[fm-track] error al listar grupos:', String(err));
  }
}
export async function ensureGroupsCache() {
  await Promise.all(FM_TRACK_API_KEYS.map((k) => ensureGroupsCacheForKey(k)));
}
export const groupApiKey = (groupId) => groupKeyIndex.get(groupId) || FM_TRACK_API_KEY;

// Vehículos a enviar: los pedidos explícitamente o, si no, los del grupo en fm-track
// (fm-track es la fuente de verdad de qué vehículos tiene cada grupo).
export async function resolveVehicleIds(groupId, vehicleIds) {
  if (vehicleIds || !groupId) return vehicleIds || [];
  await ensureGroupsCache();
  const fmGroup = groupsCache.groups.find((g) => g.id === groupId);
  if (!fmGroup) throw new Error('grupo no existe en fm-track: ' + groupId);
  return fmGroup.vehicles || [];
}

// ---------- posiciones ----------
// knownTs recuerda qué ts recientes ya están en la base para insertar solo lo nuevo
// (incluye puntos "atrasados" que el equipo sube después de estar sin cobertura).
const knownTs = new Map(); // vehicleId → Set<epoch ms>
export async function initPositionIndex() {
  try {
    for (const [k, v] of await db.loadRecentPositionTs(COORDS_LOOKBACK_MIN + 10)) knownTs.set(k, v);
  } catch (err) {
    console.warn('[positions] no se pudo cargar el índice de posiciones recientes:', String(err));
  }
}
async function persistCoordinates(objectId, items) {
  const id = String(objectId);
  const pts = normalizePoints(items);
  if (!pts.length) return;
  let set = knownTs.get(id);
  if (!set) { set = new Set(); knownTs.set(id, set); }
  const fresh = pts.filter((p) => !set.has(p.t));
  if (fresh.length) {
    await db.insertPositions(id, fresh);
    for (const p of fresh) set.add(p.t);
  }
  const cutoff = Date.now() - (COORDS_LOOKBACK_MIN + 10) * 60 * 1000;
  for (const t of set) if (t < cutoff) set.delete(t);
}

async function fetchLatestCoordinate(objectId, lookbackMin = COORDS_LOOKBACK_MIN, apiKey = FM_TRACK_API_KEY) {
  const to = new Date().toISOString();
  const from = new Date(Date.now() - lookbackMin * 60 * 1000).toISOString();
  // limit=1000: el default de fm-track es 100 y la ventana de 60 min puede traer más puntos
  const path = `/objects/${encodeURIComponent(objectId)}/coordinates?fromDatetime=${encodeURIComponent(from)}&toDatetime=${encodeURIComponent(to)}&limit=1000`;
  const r = await callFmTrack(path, apiKey);
  if (!r.ok) return null;
  const items = toArray(r.data?.items ?? r.data);
  if (!items.length) return null;
  persistCoordinates(objectId, items).catch((err) => console.warn('[positions] error guardando posiciones:', String(err)));
  items.sort((a, b) => new Date(b.datetime || 0) - new Date(a.datetime || 0));
  return items[0];
}

const objectId = (o) => pick(o, ['id', 'object_id', 'uuid', 'imei']);

async function refreshPositionsCacheForKey(apiKey) {
  const cache = getPositionsCacheFor(apiKey);
  const objsRes = await callFmTrack('/objects', apiKey);
  if (!objsRes.ok) throw new Error(`fm-track /objects (key ${apiKey.slice(0, 6)}…) → HTTP ${objsRes.status}`);
  cache.objects = toArray(objsRes.data);

  const ids = cache.objects.map(objectId).filter(Boolean);
  for (const id of ids) vehicleKeyIndex.set(String(id), apiKey);

  const results = await mapLimit(ids, FM_TRACK_CONCURRENCY, (id) =>
    fetchLatestCoordinate(id, COORDS_LOOKBACK_MIN, apiKey).then((p) => [String(id), p])
  );
  cache.byId = new Map();
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value && r.value[1]) cache.byId.set(r.value[0], r.value[1]);
  }
  cache.fetchedAt = Date.now();
}

// Refresca en paralelo los caches vencidos de todos los tenants
export async function ensurePositions() {
  await Promise.all(FM_TRACK_API_KEYS.map(async (apiKey) => {
    const cache = getPositionsCacheFor(apiKey);
    if (Date.now() - cache.fetchedAt > POSITIONS_TTL_MS) {
      try { await refreshPositionsCacheForKey(apiKey); } catch (e) {
        await db.appendActivity({ kind: 'fm_track_refresh_error', apiKey: apiKey.slice(0, 6) + '…', error: String(e) });
      }
    }
  }));
}

// Objeto fm-track + última posición del vehículo. Si no reportó en la última hora,
// busca hacia atrás hasta 7 días.
export async function getPositionsForId(vehicleId) {
  await ensurePositions();
  const vidStr = String(vehicleId);
  const apiKey = vehicleKeyIndex.get(vidStr) || FM_TRACK_API_KEY;
  const cache = getPositionsCacheFor(apiKey);
  const obj = cache.objects.find((o) => String(objectId(o)) === vidStr);
  let pos = cache.byId.get(vidStr);
  if (!pos) {
    for (const minutes of [COORDS_LOOKBACK_MIN, 24 * 60, 7 * 24 * 60]) {
      pos = await fetchLatestCoordinate(vehicleId, minutes, apiKey);
      if (pos) break;
    }
  }
  return { obj, pos };
}

// Tenant fm-track del vehículo; si aún no hay índice, fuerza un refresh.
export async function resolveApiKey(vehicleId) {
  if (!vehicleKeyIndex.has(String(vehicleId))) await ensurePositions();
  return vehicleKeyIndex.get(String(vehicleId)) || FM_TRACK_API_KEY;
}
