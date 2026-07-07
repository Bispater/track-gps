import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import * as db from './db.js';

const {
  FM_TRACK_BASE_URL = 'https://api.fm-track.com',
  TARGET_API_URL = '',
  TARGET_API_KEY = '',
  PORT = 3000,
  FM_TRACK_VERSION = '1',
  FALABELLA_TEST_URL = 'https://tms-uat-services.falabella.supply/api/v1/ms-tms-gps-aggregator/gps/position',
  FALABELLA_PROD_URL = 'https://tms-services.falabella.supply/api/v1/ms-tms-gps-aggregator/gps/position',
  FALABELLA_APIKEY = '',
  FALABELLA_AUTHORIZATION = '',
  FALABELLA_PROD_APIKEY = '',
  FALABELLA_PROD_AUTHORIZATION = '',
  FALABELLA_X_COUNTRY = 'CL',
  FALABELLA_USER_AGENT = 'gps/1.0.0',
  FALABELLA_PROVIDER_DNI = '',
  FALABELLA_PROVIDER_NAME = '',
  FALABELLA_TIMEZONE = 'America/Santiago',
  ALLOWED_GROUPS = '',
  FALABELLA_GROUPS = '',
  WISE_API_URL = 'https://gw2.wisetrack.cl/Sotraser/1.0/InsertarPosicion',
  WISE_API_TOKEN = '',
  WISE_GROUPS = '',
  WISE_TIMEZONE = 'America/Santiago',
  DRIVIN_API_URL = 'https://external.driv.in/api/external/v2/positions',
  DRIVIN_API_KEY = '',
  DRIVIN_GROUPS = '',
  BERMANN_API_BASE = 'https://concentrador.bermann.cl/integracion_bermann/api',
  BERMANN_ID_CLIENTE_EXTERNO = '',
  BERMANN_USERNAME = '',
  BERMANN_PASSWORD = '',
  BERMANN_GROUPS = '',
  DS_API_URL = 'http://18.232.149.50/api/v1/postDataGPS',
  DS_EMPRESA = '',
  DS_RUT = '',
  DS_GROUPS = '',
  DS_TIMEZONE = 'America/Santiago',
} = process.env;

function makeGroupSet(raw) {
  return new Set((raw || '').split(',').map((s) => s.trim()).filter(Boolean));
}
const ALLOWED_GROUPS_SET = makeGroupSet(ALLOWED_GROUPS);
const FALABELLA_GROUPS_SET = makeGroupSet(FALABELLA_GROUPS || ALLOWED_GROUPS);
const WISE_GROUPS_SET = makeGroupSet(WISE_GROUPS);
const DRIVIN_GROUPS_SET = makeGroupSet(DRIVIN_GROUPS);
const BERMANN_GROUPS_SET = makeGroupSet(BERMANN_GROUPS);
const DS_GROUPS_SET = makeGroupSet(DS_GROUPS);

function isInSet(g, set) {
  if (set.size === 0) return true;
  return set.has(g.name) || set.has(g.id);
}
const isGroupAllowed = (g) => isInSet(g, ALLOWED_GROUPS_SET);
const isFalabellaGroupAllowed = (g) => isInSet(g, FALABELLA_GROUPS_SET);
const isWiseGroupAllowed = (g) => isInSet(g, WISE_GROUPS_SET);
const isDrivinGroupAllowed = (g) => isInSet(g, DRIVIN_GROUPS_SET);
const isBermannGroupAllowed = (g) => isInSet(g, BERMANN_GROUPS_SET);
const isDsGroupAllowed = (g) => isInSet(g, DS_GROUPS_SET);

// Limpia llaves/espacios que muchas veces se pegan con el placeholder de la doc
const cleanKey = (s) => (s || '').trim().replace(/^[{<\[]+|[}>\]]+$/g, '');
const FM_TRACK_API_KEY = cleanKey(process.env.FM_TRACK_API_KEY);
// Soporte multi-tenant fm-track: hasta 4 claves adicionales (FM_TRACK_API_KEY_2, _3, _4, _5)
const FM_TRACK_API_KEYS = [
  FM_TRACK_API_KEY,
  cleanKey(process.env.FM_TRACK_API_KEY_2),
  cleanKey(process.env.FM_TRACK_API_KEY_3),
  cleanKey(process.env.FM_TRACK_API_KEY_4),
  cleanKey(process.env.FM_TRACK_API_KEY_5),
].filter(Boolean);

// Inicializa Postgres (espera a que esté listo y crea el schema). Debe correr
// antes de cualquier load* que lea de la DB.
await db.initDb();

const appendLog = (e) => db.appendActivity(e);

// ---------- Retención de historiales ----------
// Cada día se borran de Postgres los registros más viejos que RETENTION_DAYS.
const RETENTION_DAYS = Math.max(1, Number(process.env.RETENTION_DAYS || 15));

async function pruneAllHistories() {
  const { removed } = await db.pruneHistory(RETENTION_DAYS);
  if (removed > 0) {
    console.log(`[retention] purgados ${removed} registros más viejos que ${RETENTION_DAYS} días`);
  }
}

// Arrancar la purga al inicio y luego cada 24h
setTimeout(() => pruneAllHistories().catch(() => {}), 10 * 1000); // a los 10s del arranque
setInterval(() => pruneAllHistories().catch(() => {}), 24 * 3600 * 1000);

// ---------- fm-track (multi-tenant: una API key por tenant) ----------
function buildFmTrackUrl(relPath, apiKey = FM_TRACK_API_KEY) {
  const slash = relPath.startsWith('/') ? '' : '/';
  const url = new URL(`${FM_TRACK_BASE_URL.replace(/\/$/, '')}${slash}${relPath}`);
  if (!url.searchParams.has('version')) url.searchParams.set('version', FM_TRACK_VERSION);
  url.searchParams.set('api_key', apiKey);
  return url.toString();
}
async function callFmTrack(relPath, apiKey = FM_TRACK_API_KEY) {
  const upstream = await fetch(buildFmTrackUrl(relPath, apiKey), {
    headers: { Accept: 'application/json', 'X-Api-Key': apiKey },
  });
  const text = await upstream.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: upstream.status, ok: upstream.ok, data: body };
}

// Multi-tenant: cache de positions/groups por apiKey. Cada tenant fm-track tiene su propio cache.
const POSITIONS_TTL_MS = 10000;
const COORDS_LOOKBACK_MIN = 60;
const GROUPS_TTL_MS = 30000;

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

// Vista agregada: alias de compatibilidad con código viejo que usaba un solo cache.
// positionsCache.objects/byId = unión de todos los tenants.
const positionsCache = {
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
const groupsCache = {
  get fetchedAt() {
    return Math.max(0, ...Array.from(groupsCachesByKey.values()).map((c) => c.fetchedAt));
  },
  get groups() {
    return Array.from(groupsCachesByKey.values()).flatMap((c) => c.groups);
  },
};

async function ensureGroupsCacheForKey(apiKey) {
  const cache = getGroupsCacheFor(apiKey);
  if (Date.now() - cache.fetchedAt < GROUPS_TTL_MS) return;
  try {
    const r = await callFmTrack('/object-groups', apiKey);
    if (!r.ok) return;
    const items = toArray(r.data?.items ?? r.data);
    cache.groups = items.map((g) => ({
      id: String(g.id), name: String(g.name || ''),
      vehicles: Array.isArray(g.objects_ids) ? g.objects_ids.map(String) : [],
    }));
    // Index para resolver tenant por groupId
    for (const g of cache.groups) groupKeyIndex.set(g.id, apiKey);
    cache.fetchedAt = Date.now();
  } catch {}
}
async function ensureGroupsCache() {
  await Promise.all(FM_TRACK_API_KEYS.map((k) => ensureGroupsCacheForKey(k)));
}

function toArray(x) {
  if (Array.isArray(x)) return x;
  if (x && Array.isArray(x.items)) return x.items;
  if (x && Array.isArray(x.data)) return x.data;
  return x ? [x] : [];
}
function pick(o, paths, fb) {
  if (!o) return fb;
  for (const p of paths) {
    const v = p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
    if (v != null && v !== '') return v;
  }
  return fb;
}

async function fetchLatestCoordinate(objectId, lookbackMin = COORDS_LOOKBACK_MIN, apiKey = FM_TRACK_API_KEY) {
  const to = new Date().toISOString();
  const from = new Date(Date.now() - lookbackMin * 60 * 1000).toISOString();
  const path = `/objects/${encodeURIComponent(objectId)}/coordinates?fromDatetime=${encodeURIComponent(from)}&toDatetime=${encodeURIComponent(to)}`;
  const r = await callFmTrack(path, apiKey);
  if (!r.ok) return null;
  const items = toArray(r.data?.items ?? r.data);
  if (!items.length) return null;
  items.sort((a, b) => new Date(b.datetime || 0) - new Date(a.datetime || 0));
  return items[0];
}

async function refreshPositionsCacheForKey(apiKey) {
  const cache = getPositionsCacheFor(apiKey);
  const objsRes = await callFmTrack('/objects', apiKey);
  if (!objsRes.ok) throw new Error(`fm-track /objects (key ${apiKey.slice(0, 6)}…) → HTTP ${objsRes.status}`);
  cache.objects = toArray(objsRes.data);

  const ids = cache.objects.map((o) => pick(o, ['id', 'object_id', 'uuid', 'imei'])).filter(Boolean);
  // Index para resolver tenant por vehicleId
  for (const id of ids) vehicleKeyIndex.set(String(id), apiKey);

  const results = await Promise.allSettled(
    ids.map((id) => fetchLatestCoordinate(id, COORDS_LOOKBACK_MIN, apiKey).then((p) => [String(id), p]))
  );
  cache.byId = new Map();
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value && r.value[1]) cache.byId.set(r.value[0], r.value[1]);
  }
  cache.fetchedAt = Date.now();
}

async function ensurePositions() {
  // Refresca caches vencidas de TODOS los tenants en paralelo
  await Promise.all(FM_TRACK_API_KEYS.map(async (apiKey) => {
    const cache = getPositionsCacheFor(apiKey);
    if (Date.now() - cache.fetchedAt > POSITIONS_TTL_MS) {
      try { await refreshPositionsCacheForKey(apiKey); } catch (e) {
        await appendLog({ kind: 'fm_track_refresh_error', apiKey: apiKey.slice(0, 6) + '…', error: String(e) });
      }
    }
  }));
}

async function getPositionsForId(vehicleId) {
  await ensurePositions();
  const vidStr = String(vehicleId);
  const apiKey = vehicleKeyIndex.get(vidStr) || FM_TRACK_API_KEY;
  const cache = getPositionsCacheFor(apiKey);
  const obj = cache.objects.find((o) => String(pick(o, ['id', 'object_id', 'uuid', 'imei'])) === vidStr);
  let pos = cache.byId.get(vidStr);
  if (!pos) {
    for (const minutes of [COORDS_LOOKBACK_MIN, 24 * 60, 7 * 24 * 60]) {
      pos = await fetchLatestCoordinate(vehicleId, minutes, apiKey);
      if (pos) break;
    }
  }
  return { obj, pos };
}

// ---------- Helpers numéricos / fechas ----------
function clampInt(v, min, max, fb = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fb;
  return Math.max(min, Math.min(max, Math.round(n)));
}
function round(v, dec, fb = null) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fb;
  const f = 10 ** dec;
  return Math.round(n * f) / f;
}
function toIsoUtc(ts) {
  if (!ts) return new Date().toISOString();
  const d = new Date(ts);
  return isNaN(d) ? new Date().toISOString() : d.toISOString();
}

// Convierte un timestamp a ISO 8601 con offset local explícito (ej: 2026-05-26T14:21:41-04:00).
// Mantiene el mismo "instante" en el tiempo — solo cambia la representación.
function toIsoLocal(ts, tz) {
  const d = new Date(ts || Date.now());
  if (isNaN(d.getTime())) return new Date().toISOString();
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(d)) parts[p.type] = p.value;
  const hh = parts.hour === '24' ? '00' : parts.hour;
  // Calcular offset en minutos: comparar el "wall clock" en tz contra UTC del mismo instante.
  const asUtcMs = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +hh, +parts.minute, +parts.second);
  const offsetMin = Math.round((asUtcMs - d.getTime()) / 60000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const absMin = Math.abs(offsetMin);
  const oHh = String(Math.floor(absMin / 60)).padStart(2, '0');
  const oMm = String(absMin % 60).padStart(2, '0');
  return `${parts.year}-${parts.month}-${parts.day}T${hh}:${parts.minute}:${parts.second}${sign}${oHh}:${oMm}`;
}

// ---------- HTTP ----------
const app = express();
app.use(express.json({ limit: '5mb' }));

// ===================== Auth (login por cookie firmada) =====================
const AUTH_COOKIE = 'track_session';
const AUTH_SESSION_HOURS = Number(process.env.AUTH_SESSION_HOURS || 12);
// Secret para firmar la cookie. Si no se define, se genera uno al arrancar
// (las sesiones se invalidan en cada reinicio — define AUTH_SECRET en prod).
const AUTH_SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');
// Cuentas: "usuario1:clave1,usuario2:clave2". Si está vacío, la auth queda DESACTIVADA.
const AUTH_USERS = (() => {
  const map = new Map();
  for (const pair of (process.env.AUTH_USERS || '').split(',')) {
    const idx = pair.indexOf(':');
    if (idx === -1) continue;
    const u = pair.slice(0, idx).trim();
    const p = pair.slice(idx + 1).trim();
    if (u) map.set(u, p);
  }
  return map;
})();
const AUTH_ENABLED = AUTH_USERS.size > 0;

function signToken(username) {
  const exp = Date.now() + AUTH_SESSION_HOURS * 3600 * 1000;
  const payload = Buffer.from(JSON.stringify({ u: username, exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!data.exp || data.exp < Date.now()) return null;
    return data.u;
  } catch { return null; }
}
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}
function safeEqual(a, b) {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Rutas abiertas (no requieren login). El frontend (Angular) lo sirve Nginx en
// su propio contenedor; este servicio expone SOLO la API y el login.
app.get('/favicon.ico', (_req, res) => res.status(204).end());
// Healthcheck (sin auth) — lo usa el HEALTHCHECK de Docker y Caddy.
app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const expected = AUTH_USERS.get(String(username || ''));
  if (expected == null || !safeEqual(expected, password || '')) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }
  const token = signToken(username);
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `${AUTH_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${AUTH_SESSION_HOURS * 3600}; SameSite=Lax${secure}`);
  res.json({ ok: true, username });
});
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => {
  const user = AUTH_ENABLED ? verifyToken(getCookie(req, AUTH_COOKIE)) : 'dev';
  res.json({ authEnabled: AUTH_ENABLED, authenticated: Boolean(user), username: user || null });
});

// Middleware: protege todo lo demás (API-only → siempre 401 JSON si no hay sesión)
app.use((req, res, next) => {
  if (!AUTH_ENABLED) return next();
  const user = verifyToken(getCookie(req, AUTH_COOKIE));
  if (user) { req.user = user; return next(); }
  return res.status(401).json({ error: 'no autenticado' });
});

app.get('/api/config', (_req, res) => {
  res.json({
    fmTrackBaseUrl: FM_TRACK_BASE_URL,
    fmTrackKeyConfigured: Boolean(FM_TRACK_API_KEY),
    targetApiUrl: TARGET_API_URL,
    targetKeyConfigured: Boolean(TARGET_API_KEY),
  });
});

app.get('/api/fm-track', async (req, res) => {
  const relPath = req.query.path;
  if (!relPath || typeof relPath !== 'string') return res.status(400).json({ error: 'Falta ?path=' });
  if (!FM_TRACK_API_KEY) return res.status(500).json({ error: 'FM_TRACK_API_KEY no configurada' });
  try {
    const r = await callFmTrack(relPath);
    await appendLog({ kind: 'fetch', path: relPath, status: r.status, ok: r.ok });
    res.status(r.status).json(r);
  } catch (err) {
    await appendLog({ kind: 'fetch_error', path: relPath, error: String(err) });
    res.status(502).json({ error: String(err) });
  }
});

app.get('/api/snapshot', async (_req, res) => {
  if (!FM_TRACK_API_KEY) return res.status(500).json({ error: 'FM_TRACK_API_KEY no configurada' });
  try {
    await Promise.all([ensurePositions(), ensureGroupsCache()]);
    res.json({
      objects: { ok: true, status: 200, data: positionsCache.objects },
      positions: { ok: true, status: 200, data: Array.from(positionsCache.byId.values()) },
      groups: { ok: true, status: 200, data: groupsCache.groups },
    });
  } catch (err) { res.status(502).json({ error: String(err) }); }
});

// GET singular por externalId (endpoint del swagger imagen 2)
app.get('/api/fm-track/groups/:id', async (req, res) => {
  if (!FM_TRACK_API_KEY) return res.status(500).json({ error: 'FM_TRACK_API_KEY no configurada' });
  try {
    await ensureGroupsCache();
    const id = req.params.id;
    const apiKey = groupKeyIndex.get(id) || FM_TRACK_API_KEY;
    const r = await callFmTrack('/object-groups/' + encodeURIComponent(id), apiKey);
    res.status(r.status).json(r);
  } catch (err) { res.status(502).json({ error: String(err) }); }
});

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
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    await appendLog({ kind: 'forward_generic', targetUrl, method, status: r.status, ok: r.ok });
    res.json({ ok: r.ok, status: r.status, response: body });
  } catch (err) { res.status(502).json({ error: String(err) }); }
});

// ---- schedules API ----
app.get('/api/logs', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 1000);
  const entries = await db.getActivity(limit);
  res.json({ entries });
});

// ===================== Falabella =====================
const appendFalabellaHistory = (e) => db.appendHistory('falabella', e);

// falabellaGroups ahora guarda SOLO la configuración de envío por id de fm-track group
// (intervalSec, enabled, env, x_country, provider override, lastRunAt, lastSummary).
// La lista de vehículos del grupo vive siempre en fm-track (groupsCache).
let falabellaGroups = {};
function defaultGroupConfig() {
  return {
    intervalSec: 20,
    enabled: false,
    env: 'test',
    x_country: FALABELLA_X_COUNTRY || 'CL',
    provider: null, // null = usa el default del .env
    lastRunAt: null,
    lastStatus: null,
    lastSummary: null,
  };
}
async function loadFalabellaGroups() {
  falabellaGroups = await db.loadGroupConfigs('falabella');
}
async function saveFalabellaGroups() {
  await db.saveGroupConfigs('falabella', falabellaGroups);
}
await loadFalabellaGroups();

function buildFalabellaPayload(obj, pos, providerOverride) {
  // Falabella espera provider.id (RUT/DNI) y provider.description (nombre).
  // El env y la UI siguen usando "dni"/"name" por compatibilidad; el adapter renombra.
  const provider = {
    id: providerOverride?.dni || providerOverride?.id || FALABELLA_PROVIDER_DNI || '',
    description: providerOverride?.name || providerOverride?.description || FALABELLA_PROVIDER_NAME || '',
  };
  // vehicleId: la patente (sin guiones). referenceId: el id interno fm-track.
  const plateRaw = pick(obj, ['vehicle_params.plate_number', 'plate', 'license_plate']) || pick(obj, ['name']);
  const vehicleId = String(plateRaw || pick(obj, ['id']) || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const referenceId = String(pick(obj, ['id', 'object_id']) || pick(pos, ['object_id']) || vehicleId);
  const lat = round(pick(pos, ['position.latitude']), 6, 0);
  const lng = round(pick(pos, ['position.longitude']), 6, 0);
  // Falabella pide ISO 8601 con zona horaria. Enviamos en hora local con offset (mismo instante).
  const ts = toIsoLocal(pick(pos, ['datetime']), FALABELLA_TIMEZONE);
  const speedKmh = Number(pick(pos, ['position.speed']) ?? 0);
  const heading = Number(pick(pos, ['position.direction']) ?? 0);
  const ignited = pick(pos, ['ignition_status']) === 'ON';
  // sensors omitidos: Falabella exige un campo `code` por sensor que la doc pública no especifica.
  // Cuando TMS aclare el schema requerido, agregar el `code` y re-habilitar el envío.
  return {
    provider,
    vehicleId,
    referenceId,
    latitude: lat,
    longitude: lng,
    timestamp: ts,
    speed: { value: speedKmh, unit: 'KILOMETER' },
    ignited,
    heading,
  };
}

async function sendOneToFalabella({ payload, env = 'test', x_country, txref }) {
  const url = env === 'prod' ? FALABELLA_PROD_URL : FALABELLA_TEST_URL;
  const apikey = env === 'prod' ? FALABELLA_PROD_APIKEY : FALABELLA_APIKEY;
  const authz = env === 'prod' ? FALABELLA_PROD_AUTHORIZATION : FALABELLA_AUTHORIZATION;
  if (!apikey || !authz) return { ok: false, status: 0, response: { error: `credenciales ${env} no configuradas en .env` }, txref };
  const txr = txref || crypto.randomUUID();
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'apikey': apikey,
    'authorization': authz,
    'x-country': x_country || FALABELLA_X_COUNTRY,
    'X-txref': txr,
    'User-Agent': FALABELLA_USER_AGENT,
  };
  try {
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    // Falabella devuelve 200 + {message: "NO_TRACKING_CONFIGURED"} cuando la patente no está habilitada
    const accepted = r.ok && body && typeof body === 'object' && body.id;
    return { ok: r.ok, status: r.status, accepted: Boolean(accepted), response: body, txref: txr, url };
  } catch (err) {
    return { ok: false, status: 0, response: { error: String(err) }, txref: txr, url };
  }
}

async function sendForVehicles({ groupId, vehicleIds, env, x_country, providerOverride, txref }) {
  let ids = vehicleIds;
  let config = null;
  if (groupId) {
    config = falabellaGroups[groupId] || {};
    if (!ids) {
      // La lista de vehículos viene siempre de fm-track (fuente de verdad)
      await ensureGroupsCache();
      const fmGroup = groupsCache.groups.find((g) => g.id === groupId);
      if (!fmGroup) throw new Error('grupo no existe en fm-track: ' + groupId);
      ids = fmGroup.vehicles || [];
    }
  }
  if (!ids || !ids.length) return [];
  const results = [];
  for (const vid of ids) {
    try {
      const { obj, pos } = await getPositionsForId(vid);
      if (!pos) {
        const entry = { vehicleId: vid, ok: false, error: 'sin posición en últimos 7 días (vehículo apagado/sin reportar)', groupId, env: env || config?.env || 'test' };
        await appendFalabellaHistory(entry);
        results.push(entry);
        continue;
      }
      const payload = buildFalabellaPayload(obj, pos, providerOverride || config?.provider);
      const r = await sendOneToFalabella({
        payload,
        env: env || config?.env || 'test',
        x_country: x_country || config?.x_country,
        txref,
      });
      const entry = { vehicleId: vid, ...r, payload, raw: pos, groupId };
      await appendFalabellaHistory(entry);
      results.push(entry);
    } catch (err) {
      const entry = { vehicleId: vid, ok: false, error: String(err), groupId };
      await appendFalabellaHistory(entry);
      results.push(entry);
    }
  }
  return results;
}

// Lista de grupos pre-armados en fm-track (cada uno con sus objects_ids)
app.get('/api/fm-track/groups', async (_req, res) => {
  if (!FM_TRACK_API_KEY) return res.status(500).json({ error: 'FM_TRACK_API_KEY no configurada' });
  try {
    // Devuelve la unión de grupos de todos los tenants fm-track configurados
    await ensureGroupsCache();
    const groups = groupsCache.groups.filter(isGroupAllowed);
    res.json({ groups });
  } catch (err) { res.status(502).json({ error: String(err) }); }
});

app.get('/api/falabella/config', (_req, res) => {
  res.json({
    testUrl: FALABELLA_TEST_URL,
    prodUrl: FALABELLA_PROD_URL,
    apikeyTestConfigured: Boolean(FALABELLA_APIKEY),
    apikeyProdConfigured: Boolean(FALABELLA_PROD_APIKEY),
    defaultCountry: FALABELLA_X_COUNTRY,
    defaultProvider: { dni: FALABELLA_PROVIDER_DNI, name: FALABELLA_PROVIDER_NAME },
    userAgent: FALABELLA_USER_AGENT,
  });
});

// Devuelve los grupos de fm-track (filtrados por ALLOWED_GROUPS) mezclados con la config local de envío.
app.get('/api/falabella/groups', async (_req, res) => {
  try {
    await ensureGroupsCache();
    const groups = {};
    for (const g of groupsCache.groups) {
      if (!isFalabellaGroupAllowed(g)) continue;
      groups[g.id] = {
        id: g.id,
        name: g.name,
        vehicles: g.vehicles || [],
        ...defaultGroupConfig(),
        ...(falabellaGroups[g.id] || {}),
      };
    }
    res.json({ groups });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// Actualiza la config de envío de un grupo fm-track (intervalo, auto-envío, env, provider override).
app.put('/api/falabella/groups/:id', async (req, res) => {
  const id = String(req.params.id);
  const prev = falabellaGroups[id] || defaultGroupConfig();
  const next = { ...prev };
  if (req.body?.intervalSec != null) next.intervalSec = Math.max(5, Number(req.body.intervalSec) || 20);
  if (req.body?.enabled != null) next.enabled = Boolean(req.body.enabled);
  if (req.body?.env != null) next.env = String(req.body.env);
  if (req.body?.x_country != null) next.x_country = String(req.body.x_country);
  if (req.body?.provider) next.provider = { ...(prev.provider || {}), ...req.body.provider };
  falabellaGroups[id] = next;
  await saveFalabellaGroups();
  res.json(next);
});

// Resetea la config (vuelve a defaults) — la lista de vehículos no cambia, viene siempre de fm-track.
app.delete('/api/falabella/groups/:id', async (req, res) => {
  const id = String(req.params.id);
  delete falabellaGroups[id];
  await db.deleteGroupConfig('falabella', id);
  res.json({ ok: true });
});

app.post('/api/falabella/preview', async (req, res) => {
  try {
    const { vehicleId, groupId } = req.body ?? {};
    if (!vehicleId) return res.status(400).json({ ok: false, error: 'falta vehicleId' });
    const { obj, pos } = await getPositionsForId(vehicleId);
    if (!pos) return res.json({ ok: false, error: 'sin última posición' });
    const group = groupId ? falabellaGroups[groupId] : null;
    const payload = buildFalabellaPayload(obj, pos, group?.provider);
    res.json({ ok: true, payload, raw: { object: obj, position: pos } });
  } catch (err) { res.status(500).json({ ok: false, error: String(err) }); }
});

app.post('/api/falabella/send-one', async (req, res) => {
  try {
    const { vehicleId, groupId, env, x_country, providerOverride } = req.body ?? {};
    if (!vehicleId) return res.status(400).json({ error: 'falta vehicleId' });
    const [r] = await sendForVehicles({ vehicleIds: [vehicleId], groupId, env, x_country, providerOverride });
    res.json(r);
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.post('/api/falabella/groups/:id/send', async (req, res) => {
  try {
    const results = await sendForVehicles({ groupId: req.params.id, ...(req.body || {}) });
    res.json({ results });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.get('/api/falabella/history', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const groupId = req.query.groupId ? String(req.query.groupId) : null;
  const entries = await db.getHistory('falabella', { limit, groupId });
  res.json({ entries });
});

// ===================== Wise (Wisetrack) =====================
const appendWiseHistory = (e) => db.appendHistory('wise', e);

let wiseGroups = {};
function defaultWiseGroupConfig() {
  // Wise exige >=20s entre llamadas; recomienda 30-60s para evento online (45). Default 30s.
  return { intervalSec: 30, enabled: false, lastRunAt: null, lastStatus: null, lastSummary: null };
}
async function loadWiseGroups() {
  wiseGroups = await db.loadGroupConfigs('wise');
}
async function saveWiseGroups() {
  await db.saveGroupConfigs('wise', wiseGroups);
}
await loadWiseGroups();

// Adapter Wise: lat/lng como string con coma decimal, fecha "yyyy-MM-dd HH:mm:ss" en UTC.
function toWiseCoord(n) {
  if (n == null || !Number.isFinite(Number(n))) return '';
  return Number(n).toFixed(6).replace('.', ',');
}
function toWiseDatetime(ts) {
  const d = new Date(ts || Date.now());
  if (isNaN(d.getTime())) return '';
  // Spec Wisetrack v1.1: la fecha del GPS debe ir en UTC, formato yyyy-MM-dd HH:mm:ss.
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
// Evento según tabla Wise:
//   45 = posición online con ignición + conectado a la red
//   46 = posición con motor apagado
function inferWiseEvent(pos) {
  const ign = pick(pos, ['ignition_status']);
  return ign === 'ON' ? '45' : '46';
}
// Construye una posición individual (item dentro del array `posicion`)
function buildWisePosicionItem(obj, pos) {
  const plateRaw = pick(obj, ['vehicle_params.plate_number', 'plate', 'license_plate']) || pick(obj, ['name']);
  // Wisetrack registra las patentes con guión (ej: "GRJB-61"). Normalizamos para
  // insertarlo si fm-track la trae sin guión, evitando el Estado 4 ("móvil no existe").
  const patente = plateWithHyphen(plateRaw || pick(obj, ['id']) || '');
  const lat = pick(pos, ['position.latitude']);
  const lng = pick(pos, ['position.longitude']);
  const direccion = clampInt(pick(pos, ['position.direction']), 0, 359, 0);
  const velocidad = clampInt(pick(pos, ['position.speed']), 0, 999, 0);
  return {
    patente,
    fecha_hora: toWiseDatetime(pick(pos, ['datetime'])),
    latitud: toWiseCoord(lat),
    longitud: toWiseCoord(lng),
    direccion: String(direccion),
    velocidad: String(velocidad),
    estado: (lat != null && lng != null) ? '1' : '0',
    estado_ignicion: pick(pos, ['ignition_status']) === 'ON' ? '1' : '0',
    numero_evento: inferWiseEvent(pos),
  };
}
// Backwards compat: single-position payload (preview)
function buildWisePayload(obj, pos) {
  return { posicion: [buildWisePosicionItem(obj, pos)] };
}

// Tabla de estados de la respuesta Wise
const WISE_ESTADO_MAP = {
  1: 'OK',
  2: 'Error de conversión',
  3: 'Token inválido',
  4: 'Móvil no existe o no disponible',
  5: 'Registro duplicado',
  6: 'Error interno',
};
// El detalle trae la patente como primer dato del paréntesis:
//   "Registro duplicado. (FCCS23, 2026-06-07 08:09:58, 46)"  → patente = FCCS23
// OJO: la API real responde "DetalleOperacion" (el doc lo llamaba "DetalleEjecucion").
function extractWisePatente(detalle) {
  if (!detalle || typeof detalle !== 'string') return null;
  const m = detalle.match(/\(([^,)]+)/);
  return m ? m[1].trim().toUpperCase() : null;
}

// Parsea la respuesta Wise a [{ estado, patente, detalle }] (uno por ResultadoTransaccion).
function parseWiseResults(body) {
  if (!body || typeof body !== 'object') return [];
  const rop = body?.RespuestaServicioWeb?.RespuestaOperacion;
  if (rop == null) return [];
  const arr = Array.isArray(rop) ? rop : [rop];
  return arr.map((o) => {
    const rt = o?.ResultadoTransaccion || {};
    const estado = Number(rt.Estado);
    const detalle = rt.DetalleOperacion ?? rt.DetalleEjecucion ?? null;
    return {
      estado: Number.isFinite(estado) ? estado : null,
      patente: extractWisePatente(detalle),
      detalle,
    };
  });
}
function parseWiseEstados(body) {
  return parseWiseResults(body).map((r) => r.estado).filter((e) => e != null);
}
function wiseDetailFromEstados(estados) {
  if (!estados.length) return 'sin estado en respuesta';
  return estados.map((e) => `${e}: ${WISE_ESTADO_MAP[e] || 'Estado ' + e}`).join(' · ');
}

async function sendOneToWise({ payload }) {
  if (!WISE_API_TOKEN) {
    return { ok: false, status: 0, accepted: false, response: { error: 'WISE_API_TOKEN no configurado en .env' }, url: WISE_API_URL };
  }
  try {
    const r = await fetch(WISE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        Authorization: `Bearer ${WISE_API_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    const wiseResults = parseWiseResults(body);
    const estados = wiseResults.map((x) => x.estado).filter((e) => e != null);
    const accepted = estados.length > 0 && estados.every((e) => e === 1);
    return {
      ok: r.ok,
      status: r.status,
      accepted,
      estados,
      results: wiseResults,
      message: wiseDetailFromEstados(estados),
      response: body,
      url: WISE_API_URL,
    };
  } catch (err) {
    return { ok: false, status: 0, accepted: false, response: { error: String(err) }, url: WISE_API_URL };
  }
}

// ---- Wise constraints state ----
// Vehículos marcados como "no existen en Wisetrack" (estado 4) — NO reenviar hasta que se den de alta.
let wiseBlocked = new Set();
async function loadWiseBlocked() {
  wiseBlocked = await db.loadBlocked('wise');
}
await loadWiseBlocked();

// Dedupe: último datetime enviado y aceptado por vehículo (no re-inyectar la misma posición).
// Se carga desde Postgres al arranque para sobrevivir a reinicios (spec: no reinyectar exitosas).
const wiseLastSentDatetime = new Map();
async function loadWiseLastSent() {
  const m = await db.loadLastSent('wise');
  for (const [k, v] of m) wiseLastSentDatetime.set(k, v);
}
await loadWiseLastSent();

const WISE_MAX_PER_REQUEST = 300;

async function sendForVehiclesWise({ groupId, vehicleIds }) {
  let ids = vehicleIds;
  if (groupId && !ids) {
    await ensureGroupsCache();
    const fmGroup = groupsCache.groups.find((g) => g.id === groupId);
    if (!fmGroup) throw new Error('grupo no existe en fm-track: ' + groupId);
    ids = fmGroup.vehicles || [];
  }
  if (!ids || !ids.length) return [];

  // Construir items para batch + entradas saltadas
  const items = []; // { vehicleId, payloadItem, raw, datetime }
  const results = [];
  for (const vid of ids) {
    const vidStr = String(vid);
    if (wiseBlocked.has(vidStr)) {
      const entry = { vehicleId: vid, ok: false, accepted: false, error: 'vehículo bloqueado (no existe en Wisetrack)', groupId };
      await appendWiseHistory(entry);
      results.push(entry);
      continue;
    }
    try {
      const { obj, pos } = await getPositionsForId(vid);
      if (!pos) {
        const entry = { vehicleId: vid, ok: false, accepted: false, error: 'sin posición en últimos 7 días', groupId };
        await appendWiseHistory(entry);
        results.push(entry);
        continue;
      }
      const datetime = pick(pos, ['datetime']);
      if (wiseLastSentDatetime.get(vidStr) === datetime) {
        const entry = { vehicleId: vid, ok: true, accepted: false, skipped: true, message: 'sin cambios (mismo datetime)', groupId, raw: pos };
        await appendWiseHistory(entry);
        results.push(entry);
        continue;
      }
      const payloadItem = buildWisePosicionItem(obj, pos);
      items.push({ vehicleId: vid, payloadItem, raw: pos, datetime });
    } catch (err) {
      const entry = { vehicleId: vid, ok: false, accepted: false, error: String(err), groupId };
      await appendWiseHistory(entry);
      results.push(entry);
    }
    if (items.length >= WISE_MAX_PER_REQUEST) break; // Wise tope: 300/call
  }

  if (!items.length) return results;

  // Un solo POST con todas las posiciones
  const payload = { posicion: items.map((x) => x.payloadItem) };
  const batchResp = await sendOneToWise({ payload });
  const wiseResults = batchResp.results || [];
  const estados = batchResp.estados || [];

  // Mapa patente → estado (según el doc, el DetalleEjecucion identifica la patente).
  const estadoByPatente = new Map();
  for (const r of wiseResults) {
    if (r.patente != null && r.estado != null) estadoByPatente.set(r.patente, r.estado);
  }

  // Distribuir el estado a cada vehículo: primero por patente; si no calza, fallback por orden.
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const itPat = String(it.payloadItem?.patente || '').toUpperCase();
    const estado = estadoByPatente.has(itPat) ? estadoByPatente.get(itPat) : estados[i];
    const accepted = estado === 1;
    if (estado === 4) {
      // "No existe el móvil" → marcar como bloqueado y no reenviar más
      wiseBlocked.add(String(it.vehicleId));
      await db.addBlocked('wise', it.vehicleId, 'no existe en Wisetrack (estado 4)');
    }
    // Estado 1 (aceptado) o 5 (duplicado: Wisetrack YA tiene esta posición) → marcar
    // como enviada y no reinyectarla hasta que el vehículo reporte una nueva.
    if (accepted || estado === 5) {
      wiseLastSentDatetime.set(String(it.vehicleId), it.datetime);
      await db.saveLastSent('wise', it.vehicleId, it.datetime);
    }
    const entry = {
      vehicleId: it.vehicleId,
      ok: batchResp.ok,
      status: batchResp.status,
      accepted,
      estados: estado != null ? [estado] : [],
      message: estado != null ? `${estado}: ${WISE_ESTADO_MAP[estado] || 'Estado ' + estado}` : 'sin estado en respuesta',
      response: batchResp.response,
      payload: { posicion: [it.payloadItem] },
      raw: it.raw,
      url: batchResp.url,
      groupId,
      batchSize: items.length,
    };
    await appendWiseHistory(entry);
    results.push(entry);
  }
  return results;
}

app.get('/api/wise/config', (_req, res) => {
  res.json({ url: WISE_API_URL, tokenConfigured: Boolean(WISE_API_TOKEN) });
});

app.get('/api/wise/groups', async (_req, res) => {
  try {
    await ensureGroupsCache();
    const groups = {};
    for (const g of groupsCache.groups) {
      if (!isWiseGroupAllowed(g)) continue;
      groups[g.id] = {
        id: g.id,
        name: g.name,
        vehicles: g.vehicles || [],
        ...defaultWiseGroupConfig(),
        ...(wiseGroups[g.id] || {}),
      };
    }
    res.json({ groups });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.put('/api/wise/groups/:id', async (req, res) => {
  const id = String(req.params.id);
  const prev = wiseGroups[id] || defaultWiseGroupConfig();
  const next = { ...prev };
  // Spec Wisetrack: 1 llamada cada >=20s, máx 3/min. Forzamos piso de 20s (default 30s).
  if (req.body?.intervalSec != null) next.intervalSec = Math.max(20, Number(req.body.intervalSec) || 30);
  if (req.body?.enabled != null) next.enabled = Boolean(req.body.enabled);
  wiseGroups[id] = next;
  await saveWiseGroups();
  res.json(next);
});

app.delete('/api/wise/groups/:id', async (req, res) => {
  const id = String(req.params.id);
  delete wiseGroups[id];
  await db.deleteGroupConfig('wise', id);
  res.json({ ok: true });
});

app.post('/api/wise/preview', async (req, res) => {
  try {
    const { vehicleId } = req.body ?? {};
    if (!vehicleId) return res.status(400).json({ ok: false, error: 'falta vehicleId' });
    const { obj, pos } = await getPositionsForId(vehicleId);
    if (!pos) return res.json({ ok: false, error: 'sin última posición' });
    res.json({ ok: true, payload: buildWisePayload(obj, pos), raw: { object: obj, position: pos } });
  } catch (err) { res.status(500).json({ ok: false, error: String(err) }); }
});

app.post('/api/wise/send-one', async (req, res) => {
  try {
    const { vehicleId, groupId } = req.body ?? {};
    if (!vehicleId) return res.status(400).json({ error: 'falta vehicleId' });
    const [r] = await sendForVehiclesWise({ vehicleIds: [vehicleId], groupId });
    res.json(r);
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.post('/api/wise/groups/:id/send', async (req, res) => {
  try {
    const results = await sendForVehiclesWise({ groupId: req.params.id });
    res.json({ results });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.get('/api/wise/blocked', (_req, res) => {
  res.json({ vehicleIds: Array.from(wiseBlocked) });
});
app.delete('/api/wise/blocked/:id', async (req, res) => {
  const id = String(req.params.id);
  wiseBlocked.delete(id);
  await db.removeBlocked('wise', id);
  res.json({ ok: true });
});
app.post('/api/wise/blocked/clear', async (_req, res) => {
  wiseBlocked.clear();
  await db.clearBlocked('wise');
  res.json({ ok: true });
});

app.get('/api/wise/history', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const groupId = req.query.groupId ? String(req.query.groupId) : null;
  const entries = await db.getHistory('wise', { limit, groupId });
  res.json({ entries });
});

// Scheduler Wise — paralelo al de Falabella
const WISE_TICK_MS = 2000;
setInterval(async () => {
  try { await ensureGroupsCache(); } catch { return; }
  const now = Date.now();
  for (const fmGroup of groupsCache.groups) {
    if (!isWiseGroupAllowed(fmGroup)) continue;
    const config = wiseGroups[fmGroup.id];
    if (!config?.enabled) continue;
    if (!fmGroup.vehicles?.length) continue;
    const last = config.lastRunAt ? new Date(config.lastRunAt).getTime() : 0;
    if (now - last < (config.intervalSec || 20) * 1000) continue;
    config.lastRunAt = new Date().toISOString();
    try {
      const results = await sendForVehiclesWise({ groupId: fmGroup.id });
      const accepted = results.filter((x) => x.accepted).length;
      const okCount = results.filter((x) => x.ok).length;
      const failed = results.filter((x) => !x.ok).length;
      config.lastSummary = { total: results.length, accepted, ok: okCount, failed };
      config.lastStatus = failed === 0 ? (accepted === results.length ? 'ok' : 'partial') : 'err';
      await saveWiseGroups();
    } catch (err) {
      config.lastStatus = 'err';
      config.lastSummary = { error: String(err) };
      await appendLog({ kind: 'wise_scheduler_error', groupId: fmGroup.id, error: String(err) });
      await saveWiseGroups();
    }
  }
}, WISE_TICK_MS);

// Loop: cada 2s revisa qué grupos fm-track con auto-envío toca disparar
const FALABELLA_TICK_MS = 2000;
setInterval(async () => {
  try { await ensureGroupsCache(); } catch { return; }
  const now = Date.now();
  for (const fmGroup of groupsCache.groups) {
    if (!isFalabellaGroupAllowed(fmGroup)) continue; // respeta la whitelist Falabella
    const config = falabellaGroups[fmGroup.id];
    if (!config?.enabled) continue;
    if (!fmGroup.vehicles?.length) continue;
    const last = config.lastRunAt ? new Date(config.lastRunAt).getTime() : 0;
    if (now - last < (config.intervalSec || 20) * 1000) continue;
    // Marca antes de enviar para evitar disparos paralelos
    config.lastRunAt = new Date().toISOString();
    try {
      const results = await sendForVehicles({ groupId: fmGroup.id });
      const accepted = results.filter((x) => x.accepted).length;
      const okCount = results.filter((x) => x.ok).length;
      const failed = results.filter((x) => !x.ok).length;
      config.lastSummary = { total: results.length, accepted, ok: okCount, failed };
      config.lastStatus = failed === 0 ? (accepted === results.length ? 'ok' : 'partial') : 'err';
      await saveFalabellaGroups();
    } catch (err) {
      config.lastStatus = 'err';
      config.lastSummary = { error: String(err) };
      await appendLog({ kind: 'falabella_scheduler_error', groupId: fmGroup.id, error: String(err) });
      await saveFalabellaGroups();
    }
  }
}, FALABELLA_TICK_MS);

// ===================== Drivin =====================
const appendDrivinHistory = (e) => db.appendHistory('drivin', e);

let drivinGroups = {};
function defaultDrivinGroupConfig() {
  return { intervalSec: 30, enabled: false, lastRunAt: null, lastStatus: null, lastSummary: null };
}
async function loadDrivinGroups() {
  drivinGroups = await db.loadGroupConfigs('drivin');
}
async function saveDrivinGroups() {
  await db.saveGroupConfigs('drivin', drivinGroups);
}
await loadDrivinGroups();

// Adapter Drivin: payload con root "positions", "lng" minúscula, timestamp en milisegundos, speed en m/s.
function buildDrivinPositionItem(obj, pos) {
  // Drivin (según correo del cliente): device_number y vehicle_code = PATENTE SIN ESPACIOS (ej: HCKP21)
  const plateRaw = pick(obj, ['vehicle_params.plate_number', 'plate', 'license_plate']) || pick(obj, ['name']);
  const plate = String(plateRaw || '').replace(/\s+/g, '').toUpperCase().slice(0, 255);
  const deviceNumber = plate;
  const vehicleCode = plate;
  const lat = Number(pick(pos, ['position.latitude']));
  const lng = Number(pick(pos, ['position.longitude']));
  const dtRaw = pick(pos, ['datetime']);
  const tsMs = dtRaw ? new Date(dtRaw).getTime() : Date.now();
  // Drivin espera timestamp en MILISEGUNDOS (ej. de la doc: 1519135237474)
  const timestamp = Number.isFinite(tsMs) ? tsMs : Date.now();
  const speedKmh = Number(pick(pos, ['position.speed']) ?? 0);
  const heading = Number(pick(pos, ['position.direction']) ?? 0);

  const item = {
    device_number: deviceNumber,
    lat: Number.isFinite(lat) ? lat : 0,
    lng: Number.isFinite(lng) ? lng : 0,
    timestamp,
  };
  if (vehicleCode) item.vehicle_code = vehicleCode;
  // speed en m/s (fm-track lo da en km/h)
  if (Number.isFinite(speedKmh)) item.speed = round(speedKmh / 3.6, 2);
  if (Number.isFinite(heading)) item.heading = heading;

  // Temperaturas 1-indexed (temp1..temp4) según el ejemplo de la doc
  const temperature = {};
  for (let i = 0; i <= 3; i++) {
    const t = pick(pos, [`device_inputs.temperature_sensor_${i}`]);
    if (t != null && Number.isFinite(Number(t))) temperature[`temp${i + 1}`] = Number(t);
  }
  if (Object.keys(temperature).length) item.temperature = temperature;

  return item;
}
function buildDrivinPayload(obj, pos) {
  return { positions: [buildDrivinPositionItem(obj, pos)] };
}

async function sendOneToDrivin({ payload }) {
  if (!DRIVIN_API_KEY) {
    return { ok: false, status: 0, accepted: false, response: { error: 'DRIVIN_API_KEY no configurado en .env' }, url: DRIVIN_API_URL };
  }
  try {
    const r = await fetch(DRIVIN_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-API-Key': DRIVIN_API_KEY,
      },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    // 201 + { success: true, status: "OK" }
    const accepted = r.status === 201 && body && typeof body === 'object' && body.success === true;
    return { ok: r.ok, status: r.status, accepted, response: body, url: DRIVIN_API_URL };
  } catch (err) {
    return { ok: false, status: 0, accepted: false, response: { error: String(err) }, url: DRIVIN_API_URL };
  }
}

async function sendForVehiclesDrivin({ groupId, vehicleIds }) {
  let ids = vehicleIds;
  if (groupId && !ids) {
    await ensureGroupsCache();
    const fmGroup = groupsCache.groups.find((g) => g.id === groupId);
    if (!fmGroup) throw new Error('grupo no existe en fm-track: ' + groupId);
    ids = fmGroup.vehicles || [];
  }
  if (!ids || !ids.length) return [];

  const items = [];
  const results = [];
  for (const vid of ids) {
    try {
      const { obj, pos } = await getPositionsForId(vid);
      if (!pos) {
        const entry = { vehicleId: vid, ok: false, accepted: false, error: 'sin posición en últimos 7 días', groupId };
        await appendDrivinHistory(entry);
        results.push(entry);
        continue;
      }
      items.push({ vehicleId: vid, payloadItem: buildDrivinPositionItem(obj, pos), raw: pos });
    } catch (err) {
      const entry = { vehicleId: vid, ok: false, accepted: false, error: String(err), groupId };
      await appendDrivinHistory(entry);
      results.push(entry);
    }
  }
  if (!items.length) return results;

  const payload = { positions: items.map((x) => x.payloadItem) };
  const batchResp = await sendOneToDrivin({ payload });

  // Drivin no devuelve resultado por posición; el accepted del batch se aplica a todas.
  for (const it of items) {
    const entry = {
      vehicleId: it.vehicleId,
      ok: batchResp.ok,
      status: batchResp.status,
      accepted: batchResp.accepted,
      response: batchResp.response,
      payload: { positions: [it.payloadItem] },
      raw: it.raw,
      url: batchResp.url,
      groupId,
      batchSize: items.length,
    };
    await appendDrivinHistory(entry);
    results.push(entry);
  }
  return results;
}

app.get('/api/drivin/config', (_req, res) => {
  res.json({ url: DRIVIN_API_URL, keyConfigured: Boolean(DRIVIN_API_KEY) });
});

app.get('/api/drivin/groups', async (_req, res) => {
  try {
    await ensureGroupsCache();
    const groups = {};
    for (const g of groupsCache.groups) {
      if (!isDrivinGroupAllowed(g)) continue;
      groups[g.id] = {
        id: g.id, name: g.name,
        vehicles: g.vehicles || [],
        ...defaultDrivinGroupConfig(),
        ...(drivinGroups[g.id] || {}),
      };
    }
    res.json({ groups });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.put('/api/drivin/groups/:id', async (req, res) => {
  const id = String(req.params.id);
  const prev = drivinGroups[id] || defaultDrivinGroupConfig();
  const next = { ...prev };
  if (req.body?.intervalSec != null) next.intervalSec = Math.max(5, Number(req.body.intervalSec) || 30);
  if (req.body?.enabled != null) next.enabled = Boolean(req.body.enabled);
  drivinGroups[id] = next;
  await saveDrivinGroups();
  res.json(next);
});

app.delete('/api/drivin/groups/:id', async (req, res) => {
  const id = String(req.params.id);
  delete drivinGroups[id];
  await db.deleteGroupConfig('drivin', id);
  res.json({ ok: true });
});

app.post('/api/drivin/preview', async (req, res) => {
  try {
    const { vehicleId } = req.body ?? {};
    if (!vehicleId) return res.status(400).json({ ok: false, error: 'falta vehicleId' });
    const { obj, pos } = await getPositionsForId(vehicleId);
    if (!pos) return res.json({ ok: false, error: 'sin última posición' });
    res.json({ ok: true, payload: buildDrivinPayload(obj, pos), raw: { object: obj, position: pos } });
  } catch (err) { res.status(500).json({ ok: false, error: String(err) }); }
});

app.post('/api/drivin/send-one', async (req, res) => {
  try {
    const { vehicleId, groupId } = req.body ?? {};
    if (!vehicleId) return res.status(400).json({ error: 'falta vehicleId' });
    const [r] = await sendForVehiclesDrivin({ vehicleIds: [vehicleId], groupId });
    res.json(r);
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.post('/api/drivin/groups/:id/send', async (req, res) => {
  try {
    const results = await sendForVehiclesDrivin({ groupId: req.params.id });
    res.json({ results });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.get('/api/drivin/history', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const groupId = req.query.groupId ? String(req.query.groupId) : null;
  const entries = await db.getHistory('drivin', { limit, groupId });
  res.json({ entries });
});

// Scheduler Drivin
const DRIVIN_TICK_MS = 2000;
setInterval(async () => {
  try { await ensureGroupsCache(); } catch { return; }
  const now = Date.now();
  for (const fmGroup of groupsCache.groups) {
    if (!isDrivinGroupAllowed(fmGroup)) continue;
    const config = drivinGroups[fmGroup.id];
    if (!config?.enabled) continue;
    if (!fmGroup.vehicles?.length) continue;
    const last = config.lastRunAt ? new Date(config.lastRunAt).getTime() : 0;
    if (now - last < (config.intervalSec || 30) * 1000) continue;
    config.lastRunAt = new Date().toISOString();
    try {
      const results = await sendForVehiclesDrivin({ groupId: fmGroup.id });
      const accepted = results.filter((x) => x.accepted).length;
      const okCount = results.filter((x) => x.ok).length;
      const failed = results.filter((x) => !x.ok).length;
      config.lastSummary = { total: results.length, accepted, ok: okCount, failed };
      config.lastStatus = failed === 0 ? (accepted === results.length ? 'ok' : 'partial') : 'err';
      await saveDrivinGroups();
    } catch (err) {
      config.lastStatus = 'err';
      config.lastSummary = { error: String(err) };
      await appendLog({ kind: 'drivin_scheduler_error', groupId: fmGroup.id, error: String(err) });
      await saveDrivinGroups();
    }
  }
}, DRIVIN_TICK_MS);

// ===================== Bermann =====================
const appendBermannHistory = (e) => db.appendHistory('bermann', e);

let bermannGroups = {};
function defaultBermannGroupConfig() {
  return { intervalSec: 30, enabled: false, lastRunAt: null, lastStatus: null, lastSummary: null };
}
async function loadBermannGroups() {
  bermannGroups = await db.loadGroupConfigs('bermann');
}
async function saveBermannGroups() {
  await db.saveGroupConfigs('bermann', bermannGroups);
}
await loadBermannGroups();

// Token cache: dura 1h según la doc; refrescamos a los 55 min para evitar race conditions.
let bermannToken = null;
let bermannTokenExpiresAt = 0;
let bermannAuthInFlight = null; // Promise que evita múltiples auth simultáneos

async function getBermannToken({ forceRefresh = false } = {}) {
  if (!forceRefresh && bermannToken && Date.now() < bermannTokenExpiresAt) return bermannToken;
  if (bermannAuthInFlight) return bermannAuthInFlight;
  bermannAuthInFlight = (async () => {
    if (!BERMANN_ID_CLIENTE_EXTERNO || !BERMANN_USERNAME || !BERMANN_PASSWORD) {
      throw new Error('Credenciales Bermann no configuradas (.env: BERMANN_ID_CLIENTE_EXTERNO, BERMANN_USERNAME, BERMANN_PASSWORD)');
    }
    const r = await fetch(BERMANN_API_BASE.replace(/\/$/, '') + '/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        id_cliente_externo: Number(BERMANN_ID_CLIENTE_EXTERNO),
        nombre_usuario: BERMANN_USERNAME,
        password_usuario: BERMANN_PASSWORD,
      }),
    });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    if (!r.ok || !body || !body.access_token) {
      throw new Error(`Auth Bermann falló: HTTP ${r.status} · ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    }
    bermannToken = body.access_token;
    bermannTokenExpiresAt = Date.now() + 55 * 60 * 1000; // 55 min de margen sobre la hora real
    return bermannToken;
  })().finally(() => { bermannAuthInFlight = null; });
  return bermannAuthInFlight;
}

// Inserta guión entre letras y dígitos: "GKYS15" → "GKYS-15", "JL8953" → "JL-8953"
function plateWithHyphen(plate) {
  const cleaned = String(plate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = cleaned.match(/^([A-Z]+)(\d+)$/);
  return m ? `${m[1]}-${m[2]}` : cleaned;
}
// Formato UTC "yyyy-MM-dd HH:mm:ss"
function toBermannDatetime(ts) {
  let d = new Date(ts || Date.now());
  if (isNaN(d.getTime())) d = new Date();
  // Regla de negocio: no enviar fechas adelantadas a la actual
  const now = new Date();
  if (d.getTime() > now.getTime()) d = now;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function buildBermannPayload(obj, pos) {
  const imei = String(pick(obj, ['imei', 'identifier']) || '');
  const plateRaw = pick(obj, ['vehicle_params.plate_number', 'plate', 'license_plate']) || pick(obj, ['name']);
  const patente = plateWithHyphen(plateRaw);
  const lat = pick(pos, ['position.latitude']);
  const lon = pick(pos, ['position.longitude']);
  const dt = pick(pos, ['datetime']);
  const speedKmh = Number(pick(pos, ['position.speed']) ?? 0);
  const heading = clampInt(pick(pos, ['position.direction']), 0, 360, 0);
  const altitude = Number(pick(pos, ['position.altitude']) ?? 0);
  const ign = pick(pos, ['ignition_status']) === 'ON' ? 1 : 0;
  const sats = clampInt(pick(pos, ['position.satellites_count']), 0, 100, 0);
  const hdopRaw = pick(pos, ['device_inputs.hdop']);
  const hdop = hdopRaw != null && Number.isFinite(Number(hdopRaw)) ? Number(hdopRaw) : 0;
  const voltage = pick(pos, ['device_inputs.power_supply_voltage']);
  // power_supply_voltage de fm-track viene en mV; pasar a V para "voltaje_externo"
  const voltExt = voltage != null && Number.isFinite(Number(voltage)) ? round(Number(voltage) / 1000, 2) : null;

  const payload = {
    fecha: toBermannDatetime(dt),
    imei,
    patente,
    latitud: String(lat != null ? Number(lat) : ''),
    longitud: String(lon != null ? Number(lon) : ''),
    orientacion: heading,
    velocidad: round(speedKmh, 2),
    id_cliente_externo: Number(BERMANN_ID_CLIENTE_EXTERNO) || 0,
    altitud: Number.isFinite(altitude) ? Math.round(altitude) : 0,
    estado_motor: ign,
    hdop,
    num_sat: sats,
  };
  if (voltExt != null) payload.voltaje_externo = voltExt;
  return payload;
}

async function sendOneToBermann({ payload }) {
  if (!BERMANN_ID_CLIENTE_EXTERNO || !BERMANN_USERNAME || !BERMANN_PASSWORD) {
    return { ok: false, status: 0, accepted: false, response: { error: 'Credenciales Bermann no configuradas en .env' }, url: BERMANN_API_BASE };
  }
  const url = BERMANN_API_BASE.replace(/\/$/, '') + '/data/insert';
  let token;
  try { token = await getBermannToken(); }
  catch (err) { return { ok: false, status: 0, accepted: false, response: { error: String(err) }, url }; }

  async function postOnce(t) {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${t}`,
      },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { r, body };
  }

  try {
    let { r, body } = await postOnce(token);
    // Si el token expiró (401/403), refrescar y reintentar una vez
    if (r.status === 401 || r.status === 403) {
      bermannToken = null; bermannTokenExpiresAt = 0;
      try { token = await getBermannToken({ forceRefresh: true }); }
      catch (err) { return { ok: false, status: r.status, accepted: false, response: { error: 'auth refresh fallo: ' + err.message }, url }; }
      ({ r, body } = await postOnce(token));
    }
    return { ok: r.ok, status: r.status, accepted: r.ok, response: body, url };
  } catch (err) {
    return { ok: false, status: 0, accepted: false, response: { error: String(err) }, url };
  }
}

async function sendForVehiclesBermann({ groupId, vehicleIds }) {
  let ids = vehicleIds;
  if (groupId && !ids) {
    await ensureGroupsCache();
    const fmGroup = groupsCache.groups.find((g) => g.id === groupId);
    if (!fmGroup) throw new Error('grupo no existe en fm-track: ' + groupId);
    ids = fmGroup.vehicles || [];
  }
  if (!ids || !ids.length) return [];
  const results = [];
  // Bermann acepta UN objeto por request (no array), así que iteramos
  for (const vid of ids) {
    try {
      const { obj, pos } = await getPositionsForId(vid);
      if (!pos) {
        const entry = { vehicleId: vid, ok: false, accepted: false, error: 'sin posición en últimos 7 días', groupId };
        await appendBermannHistory(entry);
        results.push(entry);
        continue;
      }
      const payload = buildBermannPayload(obj, pos);
      const r = await sendOneToBermann({ payload });
      const entry = { vehicleId: vid, ...r, payload, raw: pos, groupId };
      await appendBermannHistory(entry);
      results.push(entry);
    } catch (err) {
      const entry = { vehicleId: vid, ok: false, accepted: false, error: String(err), groupId };
      await appendBermannHistory(entry);
      results.push(entry);
    }
  }
  return results;
}

app.get('/api/bermann/config', (_req, res) => {
  res.json({
    url: BERMANN_API_BASE,
    credentialsConfigured: Boolean(BERMANN_ID_CLIENTE_EXTERNO && BERMANN_USERNAME && BERMANN_PASSWORD),
    idClienteExterno: BERMANN_ID_CLIENTE_EXTERNO || null,
    tokenCached: Boolean(bermannToken && Date.now() < bermannTokenExpiresAt),
    tokenExpiresAt: bermannToken ? new Date(bermannTokenExpiresAt).toISOString() : null,
  });
});

app.get('/api/bermann/groups', async (_req, res) => {
  try {
    await ensureGroupsCache();
    const groups = {};
    for (const g of groupsCache.groups) {
      if (!isBermannGroupAllowed(g)) continue;
      groups[g.id] = {
        id: g.id, name: g.name,
        vehicles: g.vehicles || [],
        ...defaultBermannGroupConfig(),
        ...(bermannGroups[g.id] || {}),
      };
    }
    res.json({ groups });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.put('/api/bermann/groups/:id', async (req, res) => {
  const id = String(req.params.id);
  const prev = bermannGroups[id] || defaultBermannGroupConfig();
  const next = { ...prev };
  if (req.body?.intervalSec != null) next.intervalSec = Math.max(5, Number(req.body.intervalSec) || 30);
  if (req.body?.enabled != null) next.enabled = Boolean(req.body.enabled);
  bermannGroups[id] = next;
  await saveBermannGroups();
  res.json(next);
});

app.delete('/api/bermann/groups/:id', async (req, res) => {
  const id = String(req.params.id);
  delete bermannGroups[id];
  await db.deleteGroupConfig('bermann', id);
  res.json({ ok: true });
});

app.post('/api/bermann/preview', async (req, res) => {
  try {
    const { vehicleId } = req.body ?? {};
    if (!vehicleId) return res.status(400).json({ ok: false, error: 'falta vehicleId' });
    const { obj, pos } = await getPositionsForId(vehicleId);
    if (!pos) return res.json({ ok: false, error: 'sin última posición' });
    res.json({ ok: true, payload: buildBermannPayload(obj, pos), raw: { object: obj, position: pos } });
  } catch (err) { res.status(500).json({ ok: false, error: String(err) }); }
});

app.post('/api/bermann/send-one', async (req, res) => {
  try {
    const { vehicleId, groupId } = req.body ?? {};
    if (!vehicleId) return res.status(400).json({ error: 'falta vehicleId' });
    const [r] = await sendForVehiclesBermann({ vehicleIds: [vehicleId], groupId });
    res.json(r);
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.post('/api/bermann/groups/:id/send', async (req, res) => {
  try {
    const results = await sendForVehiclesBermann({ groupId: req.params.id });
    res.json({ results });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.get('/api/bermann/history', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const groupId = req.query.groupId ? String(req.query.groupId) : null;
  const entries = await db.getHistory('bermann', { limit, groupId });
  res.json({ entries });
});

// Scheduler Bermann
const BERMANN_TICK_MS = 2000;
setInterval(async () => {
  try { await ensureGroupsCache(); } catch { return; }
  const now = Date.now();
  for (const fmGroup of groupsCache.groups) {
    if (!isBermannGroupAllowed(fmGroup)) continue;
    const config = bermannGroups[fmGroup.id];
    if (!config?.enabled) continue;
    if (!fmGroup.vehicles?.length) continue;
    const last = config.lastRunAt ? new Date(config.lastRunAt).getTime() : 0;
    if (now - last < (config.intervalSec || 30) * 1000) continue;
    config.lastRunAt = new Date().toISOString();
    try {
      const results = await sendForVehiclesBermann({ groupId: fmGroup.id });
      const accepted = results.filter((x) => x.accepted).length;
      const okCount = results.filter((x) => x.ok).length;
      const failed = results.filter((x) => !x.ok).length;
      config.lastSummary = { total: results.length, accepted, ok: okCount, failed };
      config.lastStatus = failed === 0 ? (accepted === results.length ? 'ok' : 'partial') : 'err';
      await saveBermannGroups();
    } catch (err) {
      config.lastStatus = 'err';
      config.lastSummary = { error: String(err) };
      await appendLog({ kind: 'bermann_scheduler_error', groupId: fmGroup.id, error: String(err) });
      await saveBermannGroups();
    }
  }
}, BERMANN_TICK_MS);

// ===================== DS =====================
const appendDsHistory = (e) => db.appendHistory('ds', e);

let dsGroups = {};
function defaultDsGroupConfig() {
  // DS exige envío cada 60s mínimo según su doc.
  return { intervalSec: 60, enabled: false, lastRunAt: null, lastStatus: null, lastSummary: null };
}
async function loadDsGroups() {
  dsGroups = await db.loadGroupConfigs('ds');
}
async function saveDsGroups() {
  await db.saveGroupConfigs('ds', dsGroups);
}
await loadDsGroups();

// fechahora en hora local Chile, formato "yyyy-MM-dd HH:mm:ss" (sin offset)
function toDsDatetime(ts) {
  const d = new Date(ts || Date.now());
  if (isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DS_TIMEZONE, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value || '00';
  const hh = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')} ${hh}:${get('minute')}:${get('second')}`;
}

function buildDsPayload(obj, pos) {
  const idgps = String(pick(obj, ['imei', 'identifier']) || '').slice(0, 15);
  const plateRaw = pick(obj, ['vehicle_params.plate_number', 'plate', 'license_plate']) || pick(obj, ['name']);
  // patente SIN guion ni caracteres raros (la doc dice "sin guion")
  const patente = String(plateRaw || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const lat = pick(pos, ['position.latitude']);
  const lon = pick(pos, ['position.longitude']);
  const sentido = clampInt(pick(pos, ['position.direction']), 0, 360, 0);
  const velocidad = clampInt(pick(pos, ['position.speed']), 0, 1000, 0);
  const motor = pick(pos, ['ignition_status']) === 'ON' ? 1 : 0;
  // RUT empresa transportista SIN puntos ni guion
  const rut = String(DS_RUT || '').replace(/[.\-\s]/g, '');
  return {
    empresa: String(DS_EMPRESA || ''),
    rut,
    fechahora: toDsDatetime(pick(pos, ['datetime'])),
    idgps,
    patente,
    latitud: String(lat != null ? Number(lat) : ''),
    longitud: String(lon != null ? Number(lon) : ''),
    sentido,
    velocidad,
    motor,
  };
}

async function sendOneToDs({ payload }) {
  if (!DS_EMPRESA || !DS_RUT) {
    return { ok: false, status: 0, accepted: false, response: { error: 'DS_EMPRESA y DS_RUT no configurados en .env' }, url: DS_API_URL };
  }
  try {
    const r = await fetch(DS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    // DS devuelve HTTP 200 con { estado: "OK"|"Error", mensaje: "..." }
    const accepted = r.ok && body && typeof body === 'object' && String(body.estado).toUpperCase() === 'OK';
    const message = (body && typeof body === 'object' && body.mensaje) ? String(body.mensaje) : '';
    return { ok: r.ok, status: r.status, accepted, message, response: body, url: DS_API_URL };
  } catch (err) {
    return { ok: false, status: 0, accepted: false, response: { error: String(err) }, url: DS_API_URL };
  }
}

async function sendForVehiclesDs({ groupId, vehicleIds }) {
  let ids = vehicleIds;
  if (groupId && !ids) {
    await ensureGroupsCache();
    const fmGroup = groupsCache.groups.find((g) => g.id === groupId);
    if (!fmGroup) throw new Error('grupo no existe en fm-track: ' + groupId);
    ids = fmGroup.vehicles || [];
  }
  if (!ids || !ids.length) return [];
  const results = [];
  // DS recibe UN objeto por request (no array), iteramos
  for (const vid of ids) {
    try {
      const { obj, pos } = await getPositionsForId(vid);
      if (!pos) {
        const entry = { vehicleId: vid, ok: false, accepted: false, error: 'sin posición en últimos 7 días', groupId };
        await appendDsHistory(entry);
        results.push(entry);
        continue;
      }
      const payload = buildDsPayload(obj, pos);
      const r = await sendOneToDs({ payload });
      const entry = { vehicleId: vid, ...r, payload, raw: pos, groupId };
      await appendDsHistory(entry);
      results.push(entry);
    } catch (err) {
      const entry = { vehicleId: vid, ok: false, accepted: false, error: String(err), groupId };
      await appendDsHistory(entry);
      results.push(entry);
    }
  }
  return results;
}

app.get('/api/ds/config', (_req, res) => {
  res.json({
    url: DS_API_URL,
    credentialsConfigured: Boolean(DS_EMPRESA && DS_RUT),
    empresa: DS_EMPRESA || null,
    rut: DS_RUT ? DS_RUT.replace(/[.\-\s]/g, '') : null,
  });
});

app.get('/api/ds/groups', async (_req, res) => {
  try {
    await ensureGroupsCache();
    const groups = {};
    for (const g of groupsCache.groups) {
      if (!isDsGroupAllowed(g)) continue;
      groups[g.id] = {
        id: g.id, name: g.name,
        vehicles: g.vehicles || [],
        ...defaultDsGroupConfig(),
        ...(dsGroups[g.id] || {}),
      };
    }
    res.json({ groups });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.put('/api/ds/groups/:id', async (req, res) => {
  const id = String(req.params.id);
  const prev = dsGroups[id] || defaultDsGroupConfig();
  const next = { ...prev };
  // DS pide cada 60s mínimo según política
  if (req.body?.intervalSec != null) next.intervalSec = Math.max(60, Number(req.body.intervalSec) || 60);
  if (req.body?.enabled != null) next.enabled = Boolean(req.body.enabled);
  dsGroups[id] = next;
  await saveDsGroups();
  res.json(next);
});

app.delete('/api/ds/groups/:id', async (req, res) => {
  delete dsGroups[String(req.params.id)];
  await saveDsGroups();
  res.json({ ok: true });
});

app.post('/api/ds/preview', async (req, res) => {
  try {
    const { vehicleId } = req.body ?? {};
    if (!vehicleId) return res.status(400).json({ ok: false, error: 'falta vehicleId' });
    const { obj, pos } = await getPositionsForId(vehicleId);
    if (!pos) return res.json({ ok: false, error: 'sin última posición' });
    res.json({ ok: true, payload: buildDsPayload(obj, pos), raw: { object: obj, position: pos } });
  } catch (err) { res.status(500).json({ ok: false, error: String(err) }); }
});

app.post('/api/ds/send-one', async (req, res) => {
  try {
    const { vehicleId, groupId } = req.body ?? {};
    if (!vehicleId) return res.status(400).json({ error: 'falta vehicleId' });
    const [r] = await sendForVehiclesDs({ vehicleIds: [vehicleId], groupId });
    res.json(r);
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.post('/api/ds/groups/:id/send', async (req, res) => {
  try {
    const results = await sendForVehiclesDs({ groupId: req.params.id });
    res.json({ results });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.get('/api/ds/history', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const groupId = req.query.groupId ? String(req.query.groupId) : null;
  const entries = await db.getHistory('ds', { limit, groupId });
  res.json({ entries });
});

// Scheduler DS — chequea cada 5s, dispara cuando toca (mínimo 60s entre envíos)
const DS_TICK_MS = 5000;
setInterval(async () => {
  try { await ensureGroupsCache(); } catch { return; }
  const now = Date.now();
  for (const fmGroup of groupsCache.groups) {
    if (!isDsGroupAllowed(fmGroup)) continue;
    const config = dsGroups[fmGroup.id];
    if (!config?.enabled) continue;
    if (!fmGroup.vehicles?.length) continue;
    const last = config.lastRunAt ? new Date(config.lastRunAt).getTime() : 0;
    if (now - last < (config.intervalSec || 60) * 1000) continue;
    config.lastRunAt = new Date().toISOString();
    try {
      const results = await sendForVehiclesDs({ groupId: fmGroup.id });
      const accepted = results.filter((x) => x.accepted).length;
      const okCount = results.filter((x) => x.ok).length;
      const failed = results.filter((x) => !x.ok).length;
      config.lastSummary = { total: results.length, accepted, ok: okCount, failed };
      config.lastStatus = failed === 0 ? (accepted === results.length ? 'ok' : 'partial') : 'err';
      await saveDsGroups();
    } catch (err) {
      config.lastStatus = 'err';
      config.lastSummary = { error: String(err) };
      await appendLog({ kind: 'ds_scheduler_error', groupId: fmGroup.id, error: String(err) });
      await saveDsGroups();
    }
  }
}, DS_TICK_MS);

app.listen(PORT, () => {
  console.log(`track-service · http://localhost:${PORT}`);
  if (!FM_TRACK_API_KEY) console.warn('  ⚠  FM_TRACK_API_KEY no configurada');
  console.log(`  fm-track · ${FM_TRACK_API_KEYS.length} tenant(s) configurado(s)`);
  if (!FALABELLA_APIKEY || !FALABELLA_AUTHORIZATION) console.warn('  ⚠  Credenciales Falabella TEST no configuradas');
  if (!FALABELLA_PROD_APIKEY || !FALABELLA_PROD_AUTHORIZATION) console.warn('  ⚠  Credenciales Falabella PROD no configuradas');
  if (!WISE_API_TOKEN) console.warn('  ⚠  WISE_API_TOKEN no configurado');
  if (!DRIVIN_API_KEY) console.warn('  ⚠  DRIVIN_API_KEY no configurado');
  if (!BERMANN_ID_CLIENTE_EXTERNO || !BERMANN_USERNAME || !BERMANN_PASSWORD) console.warn('  ⚠  Credenciales Bermann no configuradas');
  if (!DS_EMPRESA || !DS_RUT) console.warn('  ⚠  Credenciales DS no configuradas (empresa + rut transportista)');
  if (AUTH_ENABLED) {
    console.log(`  auth · ACTIVADA · ${AUTH_USERS.size} cuenta(s)`);
    if (!process.env.AUTH_SECRET) console.warn('  ⚠  AUTH_SECRET no definido — las sesiones se invalidan en cada reinicio. Define AUTH_SECRET en .env.');
  } else {
    console.warn('  ⚠  auth DESACTIVADA (sin AUTH_USERS) — la app es pública. Define AUTH_USERS en .env para protegerla.');
  }
  const activeFal = Object.values(falabellaGroups).filter((g) => g.enabled).length;
  const activeWise = Object.values(wiseGroups).filter((g) => g.enabled).length;
  const activeDrivin = Object.values(drivinGroups).filter((g) => g.enabled).length;
  const activeBermann = Object.values(bermannGroups).filter((g) => g.enabled).length;
  const activeDs = Object.values(dsGroups).filter((g) => g.enabled).length;
  console.log(`  scheduler Falabella · ${activeFal}/${Object.keys(falabellaGroups).length} grupos activos`);
  console.log(`  scheduler Wise · ${activeWise}/${Object.keys(wiseGroups).length} grupos activos`);
  console.log(`  scheduler Drivin · ${activeDrivin}/${Object.keys(drivinGroups).length} grupos activos`);
  console.log(`  scheduler Bermann · ${activeBermann}/${Object.keys(bermannGroups).length} grupos activos`);
  console.log(`  scheduler DS · ${activeDs}/${Object.keys(dsGroups).length} grupos activos`);
});
