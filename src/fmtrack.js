// =============================================================
// fmtrack.js · cliente fm-track (fuente de los datos GPS) + datos en RAM
// =============================================================
// Multi-tenant: una API key por tenant. Un solo recolector en segundo plano habla con
// fm-track por las posiciones; los envíos, el snapshot y el mapa leen lo que ya trajo
// (RAM + position_history en Postgres) sin consultar a fm-track en cada pedido.
//
// Cada POSITIONS_POLL_MS, por tenant:
//   1. /objects-last-coordinate: una consulta con el último punto de TODOS los vehículos.
//      No trae encendido, temperatura, voltaje ni odómetro: solo dice quién tiene algo nuevo.
//   2. Para esos vehículos, /objects/{id}/coordinates desde su último punto conocido: los
//      puntos completos (el mismo formato de siempre), que además se guardan en
//      position_history para el historial del mapa.
//   Un vehículo sin punto nuevo no genera consultas. La lista de vehículos (/objects) se
//   refresca cada OBJECTS_TTL_MS, o antes si aparece uno nuevo.
// Antes, cada 10 s se pedían los últimos 60 min de cada vehículo (~110 consultas, ~48 MB/min
// en total) y cada envío de un vehículo sin reportar hace más de 1 h volvía a pedir 24 h o 7
// días de historial.
import { FM_TRACK_BASE_URL, FM_TRACK_VERSION, FM_TRACK_API_KEY, FM_TRACK_API_KEYS, env } from './config.js';
import * as db from './db.js';
import { normalizePoints } from './track-analysis.js';
import { toArray, pick, mapLimit } from './util.js';

const POSITIONS_POLL_MS = Math.max(5000, Number(env.FM_TRACK_POLL_MS || 10000));
// "Posición actual" del snapshot: punto de los últimos 60 min (igual que antes)
const COORDS_LOOKBACK_MIN = 60;
// Un punto más viejo que esto cuenta como "sin posición" (igual que antes: 7 días)
const MAX_POSITION_AGE_MS = 7 * 24 * 3600e3;
const OBJECTS_TTL_MS = 5 * 60 * 1000;
const GROUPS_TTL_MS = 30000;
// Al pedir lo nuevo de un vehículo se repiten 2 min por si llegó un punto atrasado
const OVERLAP_MS = 2 * 60 * 1000;
// Si fm-track responde 429, el tenant espera esto antes del próximo ciclo
const BACKOFF_429_MS = 30000;
// Si /objects-last-coordinate marca un punto que /coordinates todavía no devuelve, se
// reintenta en los próximos ciclos hasta esta cantidad de veces
const MAX_TRIES_SAME_POINT = 6;
// Tope por consulta del recolector (sin tope, una consulta colgada lo detendría)
const COLLECTOR_TIMEOUT_MS = 30000;
// Consultas simultáneas a fm-track por tenant al traer puntos
const FM_TRACK_CONCURRENCY = Math.max(1, Number(env.FM_TRACK_CONCURRENCY || 8));

// ---------- contador de consultas (GET /api/fm-track/stats) ----------
const statBuckets = new Map(); // minuto (epoch / 60000) → { calls, bytes, http429, errors, byKind }
const statsStartedAt = Date.now();
const kindOf = (relPath) => {
  const p = relPath.split('?')[0].replace(/^\/?/, '/');
  if (p.startsWith('/objects-last-coordinate')) return 'ultimas_posiciones';
  if (/^\/objects\/[^/]+\/coordinates/.test(p)) return 'coordenadas';
  if (p === '/objects') return 'vehiculos';
  if (p.startsWith('/object-groups')) return 'grupos';
  return 'otras';
};
function countCall(kind, status, bytes) {
  const m = Math.floor(Date.now() / 60000);
  let b = statBuckets.get(m);
  if (!b) {
    b = { calls: 0, bytes: 0, http429: 0, errors: 0, byKind: {} };
    statBuckets.set(m, b);
    for (const k of statBuckets.keys()) if (k < m - 61) statBuckets.delete(k);
  }
  b.calls++;
  b.bytes += bytes;
  if (status === 429) b.http429++;
  else if (!(status >= 200 && status < 300)) b.errors++;
  b.byKind[kind] = (b.byKind[kind] || 0) + 1;
}

// ---------- HTTP ----------
function buildFmTrackUrl(relPath, apiKey = FM_TRACK_API_KEY) {
  const slash = relPath.startsWith('/') ? '' : '/';
  const url = new URL(`${FM_TRACK_BASE_URL.replace(/\/$/, '')}${slash}${relPath}`);
  if (!url.searchParams.has('version')) url.searchParams.set('version', FM_TRACK_VERSION);
  url.searchParams.set('api_key', apiKey);
  return url.toString();
}
// timeoutMs: opcional (las consultas del recolector lo usan; las demás siguen sin tope)
export async function callFmTrack(relPath, apiKey = FM_TRACK_API_KEY, { timeoutMs } = {}) {
  const kind = kindOf(relPath);
  let upstream;
  try {
    upstream = await fetch(buildFmTrackUrl(relPath, apiKey), {
      headers: { Accept: 'application/json', 'X-Api-Key': apiKey },
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
  } catch (err) {
    countCall(kind, 0, 0);
    throw err;
  }
  const text = await upstream.text();
  countCall(kind, upstream.status, Buffer.byteLength(text));
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: upstream.status, ok: upstream.ok, data };
}

// ---------- estado en RAM ----------
// Por tenant: lista de vehículos y estado del recolector
const tenants = new Map(); // apiKey → { objects, ids, objectsAt, needObjects, tries, ready, lastOkAt, lastError }
const latestById = new Map();  // vehicleId → último punto completo conocido (formato /coordinates)
const lastTsById = new Map();  // vehicleId → epoch ms de ese punto
const bulkTsById = new Map();  // vehicleId → epoch ms del último punto según /objects-last-coordinate
const groupsCachesByKey = new Map();      // apiKey → { fetchedAt, groups }
const vehicleKeyIndex = new Map();        // vehicleId → apiKey (qué tenant tiene este vehículo)
const groupKeyIndex = new Map();          // groupId → apiKey (qué tenant tiene este grupo)
let lastCycleAt = 0;

const objectId = (o) => pick(o, ['id', 'object_id', 'uuid', 'imei']);
const pointTs = (p) => new Date(p?.datetime).getTime();

function getTenant(apiKey) {
  if (!tenants.has(apiKey)) {
    let resolveReady;
    const ready = new Promise((r) => { resolveReady = r; });
    tenants.set(apiKey, {
      objects: [], ids: new Set(), objectsAt: 0, needObjects: true, tries: new Map(),
      ready, resolveReady, lastOkAt: 0, lastError: null,
    });
  }
  return tenants.get(apiKey);
}
function getGroupsCacheFor(apiKey) {
  if (!groupsCachesByKey.has(apiKey)) {
    groupsCachesByKey.set(apiKey, { fetchedAt: 0, groups: [] });
  }
  return groupsCachesByKey.get(apiKey);
}

// Vista agregada de todos los tenants (la usa /api/snapshot)
export const positionsCache = {
  get fetchedAt() { return lastCycleAt; },
  get objects() {
    return Array.from(tenants.values()).flatMap((t) => t.objects);
  },
  // Igual que antes: solo vehículos con un punto en los últimos 60 min
  get byId() {
    const cutoff = Date.now() - COORDS_LOOKBACK_MIN * 60 * 1000;
    const all = new Map();
    for (const t of tenants.values()) {
      for (const o of t.objects) {
        const id = String(objectId(o));
        const p = latestById.get(id);
        if (p && pointTs(p) >= cutoff) all.set(id, p);
      }
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
// Una sola consulta en curso por tenant aunque la pidan varios a la vez; tras un error se
// espera 5 s antes de reintentar (antes cada pedido reintentaba y fm-track respondía 429).
const groupsInFlight = new Map(); // apiKey → Promise
function ensureGroupsCacheForKey(apiKey) {
  const cache = getGroupsCacheFor(apiKey);
  if (Date.now() - cache.fetchedAt < GROUPS_TTL_MS || Date.now() < (cache.retryAt || 0)) return Promise.resolve();
  if (groupsInFlight.has(apiKey)) return groupsInFlight.get(apiKey);
  const p = refreshGroupsForKey(apiKey, cache).finally(() => groupsInFlight.delete(apiKey));
  groupsInFlight.set(apiKey, p);
  return p;
}
async function refreshGroupsForKey(apiKey, cache) {
  try {
    const r = await callFmTrack('/object-groups', apiKey, { timeoutMs: COLLECTOR_TIMEOUT_MS });
    if (!r.ok) {
      cache.retryAt = Date.now() + 5000;
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
    cache.retryAt = Date.now() + 5000;
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

// Puntos completos de un vehículo desde `fromMs` hasta ahora (se guardan en position_history)
async function fetchPoints(id, apiKey, fromMs) {
  const to = new Date().toISOString();
  const from = new Date(fromMs).toISOString();
  // limit=1000: el default de fm-track es 100
  const path = `/objects/${encodeURIComponent(id)}/coordinates?fromDatetime=${encodeURIComponent(from)}&toDatetime=${encodeURIComponent(to)}&limit=1000`;
  const r = await callFmTrack(path, apiKey, { timeoutMs: COLLECTOR_TIMEOUT_MS });
  if (!r.ok) {
    const err = new Error(`fm-track coordinates ${id} → HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  const items = toArray(r.data?.items ?? r.data);
  if (items.length) persistCoordinates(id, items).catch((err) => console.warn('[positions] error guardando posiciones:', String(err)));
  return items;
}
// Se queda con el punto más nuevo (entre lo conocido y lo recién traído)
function keepLatest(id, items) {
  let best = latestById.get(id) || null;
  let bestTs = best ? pointTs(best) : -Infinity;
  for (const it of items) {
    const t = pointTs(it);
    if (Number.isFinite(t) && t > bestTs) { best = it; bestTs = t; }
  }
  if (best) { latestById.set(id, best); lastTsById.set(id, bestTs); }
  return best;
}
// Desde dónde pedir: lo nuevo desde el último punto conocido; la primera vez, la última hora
// (como antes) o, si su último punto es más viejo, una ventana chica alrededor de ese punto.
function fetchFrom(id, bulkMs) {
  const last = lastTsById.get(id);
  if (last != null) return Math.max(last - OVERLAP_MS, Date.now() - MAX_POSITION_AGE_MS);
  const hourAgo = Date.now() - COORDS_LOOKBACK_MIN * 60 * 1000;
  return bulkMs >= hourAgo ? hourAgo : bulkMs - 10 * 60 * 1000;
}

async function refreshObjects(apiKey, t) {
  const r = await callFmTrack('/objects', apiKey, { timeoutMs: COLLECTOR_TIMEOUT_MS });
  if (!r.ok) {
    const err = new Error(`fm-track /objects (key ${apiKey.slice(0, 6)}…) → HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  t.objects = toArray(r.data);
  t.ids = new Set(t.objects.map(objectId).filter(Boolean).map(String));
  for (const id of t.ids) vehicleKeyIndex.set(id, apiKey);
  t.objectsAt = Date.now();
  t.needObjects = false;
}
// Último punto de cada vehículo del tenant (paginado)
async function fetchLastCoordinates(apiKey) {
  const out = [];
  let token = null;
  for (let page = 0; page < 100; page++) {
    const qs = new URLSearchParams({ version: '2', limit: '200' });
    if (token) qs.set('continuation_token', token);
    const r = await callFmTrack(`/objects-last-coordinate?${qs}`, apiKey, { timeoutMs: COLLECTOR_TIMEOUT_MS });
    if (!r.ok) {
      const err = new Error(`fm-track /objects-last-coordinate (key ${apiKey.slice(0, 6)}…) → HTTP ${r.status}`);
      err.status = r.status;
      throw err;
    }
    out.push(...toArray(r.data?.results ?? r.data?.items ?? r.data));
    token = r.data?.continuation_token;
    if (!token) break;
  }
  return out;
}

async function collectTenant(apiKey, t) {
  if (t.needObjects || Date.now() - t.objectsAt > OBJECTS_TTL_MS) {
    try { await refreshObjects(apiKey, t); }
    catch (err) { if (!t.objects.length || err.status === 429) throw err; t.lastError = String(err); }
  }
  const now = Date.now();
  let last;
  try {
    last = await fetchLastCoordinates(apiKey);
    t.noBulk = false;
  } catch (err) {
    if (![403, 404].includes(err.status)) throw err;
    // Cuenta sin acceso a /objects-last-coordinate: se piden los puntos de todos sus
    // vehículos cada ciclo (como antes, pero solo lo nuevo de cada uno)
    t.noBulk = true;
    const nowIso = new Date(now).toISOString();
    last = t.objects.map((o) => ({ id: objectId(o), last_coordinate: { datetime: nowIso } }));
  }
  const todo = [];
  let unknown = false;
  for (const o of last) {
    const id = String(o?.id ?? '');
    const b = Date.parse(o?.last_coordinate?.datetime);
    if (!id || !Number.isFinite(b)) continue;
    bulkTsById.set(id, b);
    if (!t.ids.has(id)) unknown = true;
    if (b < now - MAX_POSITION_AGE_MS) continue;       // más de 7 días: sin posición
    const known = lastTsById.get(id);
    if (known != null && b <= known) continue;          // nada nuevo
    const tr = t.tries.get(id);
    if (tr && tr.b === b && tr.n >= MAX_TRIES_SAME_POINT) continue;
    todo.push([id, b]);
  }
  // Vehículo nuevo en la cuenta: refrescar la lista en el próximo ciclo (máx. 1 vez por minuto)
  if (unknown && now - t.objectsAt > 60 * 1000) t.needObjects = true;
  const results = await mapLimit(todo, FM_TRACK_CONCURRENCY, async ([id, b]) => {
    const tr = t.tries.get(id);
    t.tries.set(id, tr && tr.b === b ? { b, n: tr.n + 1 } : { b, n: 1 });
    keepLatest(id, await fetchPoints(id, apiKey, fetchFrom(id, b)));
  });
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.some((r) => r.reason?.status === 429)) {
    const err = new Error(`fm-track 429 en ${failed.length} de ${todo.length} consultas de puntos`);
    err.status = 429;
    throw err;
  }
  t.lastError = failed.length ? `${failed.length} de ${todo.length} consultas de puntos fallaron: ${String(failed[0].reason)}`
    : t.noBulk ? 'sin acceso a /objects-last-coordinate: se consulta vehículo por vehículo' : null;
}

async function runTenant(apiKey) {
  const t = getTenant(apiKey);
  const started = Date.now();
  let delay = POSITIONS_POLL_MS;
  try {
    await collectTenant(apiKey, t);
    t.lastOkAt = Date.now();
  } catch (err) {
    t.lastError = String(err);
    if (err?.status === 429) delay = BACKOFF_429_MS;
    await db.appendActivity({ kind: 'fm_track_refresh_error', apiKey: apiKey.slice(0, 6) + '…', error: String(err) }).catch(() => {});
  } finally {
    lastCycleAt = Date.now();
    if (t.resolveReady) { t.resolveReady(); t.resolveReady = null; }
  }
  setTimeout(() => runTenant(apiKey), Math.max(1000, delay - (Date.now() - started)));
}

let collectorStarted = false;
// Arranca el recolector (una vez). Lo llama server.js al iniciar.
export function startPositionCollector() {
  if (collectorStarted) return;
  collectorStarted = true;
  for (const apiKey of FM_TRACK_API_KEYS) runTenant(apiKey);
}

// Antes refrescaba si el cache tenía más de 10 s; ahora el recolector refresca solo y esto
// solo espera la primera carga (al arrancar).
export async function ensurePositions() {
  startPositionCollector();
  await Promise.all(FM_TRACK_API_KEYS.map((k) => getTenant(k).ready));
}

// Si el recolector sabe que el vehículo tiene un punto reciente pero aún no lo trajo
// completo (p. ej. falló esa consulta), se pide en el momento, una sola vez a la vez.
const missingInFlight = new Map(); // vehicleId → Promise
function fetchMissing(id, apiKey) {
  if (missingInFlight.has(id)) return missingInFlight.get(id);
  const p = fetchPoints(id, apiKey, fetchFrom(id, bulkTsById.get(id)))
    .then((items) => keepLatest(id, items))
    .catch(() => null)
    .finally(() => missingInFlight.delete(id));
  missingInFlight.set(id, p);
  return p;
}

// Cuenta sin /objects-last-coordinate: no se sabe cuándo fue su último punto, así que se
// busca hacia atrás 24 h y luego 7 días (como antes)
async function fetchMissingDeep(id, apiKey) {
  for (const ms of [24 * 3600e3, MAX_POSITION_AGE_MS]) {
    try {
      const best = keepLatest(id, await fetchPoints(id, apiKey, Date.now() - ms));
      if (best) return best;
    } catch { return null; }
  }
  return null;
}

// Objeto fm-track + último punto del vehículo (null si no tiene uno de los últimos 7 días)
export async function getPositionsForId(vehicleId) {
  await ensurePositions();
  const id = String(vehicleId);
  const apiKey = vehicleKeyIndex.get(id) || FM_TRACK_API_KEY;
  const obj = getTenant(apiKey).objects.find((o) => String(objectId(o)) === id);
  const minTs = Date.now() - MAX_POSITION_AGE_MS;
  let pos = latestById.get(id) || null;
  if (!pos && getTenant(apiKey).noBulk) pos = await fetchMissingDeep(id, apiKey);
  else if (!pos && (bulkTsById.get(id) ?? -Infinity) >= minTs) pos = await fetchMissing(id, apiKey);
  if (pos && !(pointTs(pos) >= minTs)) pos = null;
  return { obj, pos };
}

// Todos los vehículos (de todos los tenants) con su último punto, de RAM: no consulta
// fm-track. pos = null si no tiene un punto de los últimos 7 días. Lo usa la API externa.
export function getLatestPositions() {
  const minTs = Date.now() - MAX_POSITION_AGE_MS;
  const out = [];
  for (const t of tenants.values()) {
    for (const o of t.objects) {
      const id = String(objectId(o));
      const p = latestById.get(id);
      out.push({ id, obj: o, pos: p && pointTs(p) >= minTs ? p : null });
    }
  }
  return out;
}

// Tenant fm-track del vehículo; si aún no hay índice, espera la primera carga.
export async function resolveApiKey(vehicleId) {
  if (!vehicleKeyIndex.has(String(vehicleId))) await ensurePositions();
  return vehicleKeyIndex.get(String(vehicleId)) || FM_TRACK_API_KEY;
}

// Diagnóstico: consultas a fm-track por minuto y estado del recolector
export function getFmTrackStats() {
  const nowMin = Math.floor(Date.now() / 60000);
  const sum = (mins) => {
    const out = { minutos: 0, consultas: 0, mb: 0, http429: 0, otrosErrores: 0, porTipo: {} };
    // solo minutos completos (sin el minuto en curso) desde que arrancó
    const firstFull = Math.floor(statsStartedAt / 60000) + 1;
    for (let m = Math.max(nowMin - mins, firstFull); m < nowMin; m++) {
      out.minutos++;
      const b = statBuckets.get(m);
      if (!b) continue;
      out.consultas += b.calls; out.mb += b.bytes / 1048576; out.http429 += b.http429; out.otrosErrores += b.errors;
      for (const [k, v] of Object.entries(b.byKind)) out.porTipo[k] = (out.porTipo[k] || 0) + v;
    }
    const n = out.minutos || 1;
    return { ...out, mb: Math.round(out.mb * 100) / 100,
      porMinuto: { consultas: Math.round((out.consultas / n) * 10) / 10, mb: Math.round((out.mb / n) * 100) / 100 } };
  };
  return {
    arranque: new Date(statsStartedAt).toISOString(),
    cicloSeg: POSITIONS_POLL_MS / 1000,
    ultimos5min: sum(5),
    ultimos60min: sum(60),
    tenants: FM_TRACK_API_KEYS.map((k) => {
      const t = getTenant(k);
      return { key: k.slice(0, 6) + '…', vehiculos: t.objects.length,
        ultimoCicloOk: t.lastOkAt ? new Date(t.lastOkAt).toISOString() : null, error: t.lastError };
    }),
    vehiculosConPosicion: latestById.size,
  };
}
