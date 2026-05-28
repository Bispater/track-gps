import 'dotenv/config';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
} = process.env;

function makeGroupSet(raw) {
  return new Set((raw || '').split(',').map((s) => s.trim()).filter(Boolean));
}
const ALLOWED_GROUPS_SET = makeGroupSet(ALLOWED_GROUPS);
const FALABELLA_GROUPS_SET = makeGroupSet(FALABELLA_GROUPS || ALLOWED_GROUPS);
const WISE_GROUPS_SET = makeGroupSet(WISE_GROUPS);

function isInSet(g, set) {
  if (set.size === 0) return true;
  return set.has(g.name) || set.has(g.id);
}
const isGroupAllowed = (g) => isInSet(g, ALLOWED_GROUPS_SET);
const isFalabellaGroupAllowed = (g) => isInSet(g, FALABELLA_GROUPS_SET);
const isWiseGroupAllowed = (g) => isInSet(g, WISE_GROUPS_SET);

// Limpia llaves/espacios que muchas veces se pegan con el placeholder de la doc
const FM_TRACK_API_KEY = (process.env.FM_TRACK_API_KEY || '').trim().replace(/^[{<\[]+|[}>\]]+$/g, '');

const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'activity.jsonl');
const FALABELLA_GROUPS_FILE = path.join(LOG_DIR, 'falabella-groups.json');
const FALABELLA_HISTORY_FILE = path.join(LOG_DIR, 'falabella-history.jsonl');
const WISE_GROUPS_FILE = path.join(LOG_DIR, 'wise-groups.json');
const WISE_HISTORY_FILE = path.join(LOG_DIR, 'wise-history.jsonl');
const WISE_BLOCKED_FILE = path.join(LOG_DIR, 'wise-blocked.json');
await fs.mkdir(LOG_DIR, { recursive: true });

async function appendJsonl(file, entry) {
  await fs.appendFile(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8');
}
const appendLog = (e) => appendJsonl(LOG_FILE, e);

// ---------- Retención de historiales ----------
// Cada día se reescriben los .jsonl filtrando entries más viejos que RETENTION_DAYS.
const RETENTION_DAYS = Math.max(1, Number(process.env.RETENTION_DAYS || 15));

async function pruneJsonlFile(file, days = RETENTION_DAYS) {
  try {
    const raw = await fs.readFile(file, 'utf8').catch(() => '');
    if (!raw) return { kept: 0, removed: 0 };
    const cutoff = Date.now() - days * 86400 * 1000;
    const lines = raw.split('\n').filter(Boolean);
    const kept = [];
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        const ts = e.ts ? new Date(e.ts).getTime() : 0;
        if (ts >= cutoff) kept.push(line);
      } catch { /* línea corrupta: descartar */ }
    }
    if (kept.length !== lines.length) {
      await fs.writeFile(file, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
    }
    return { kept: kept.length, removed: lines.length - kept.length };
  } catch (err) {
    console.warn(`prune fallo en ${file}:`, String(err));
    return { kept: 0, removed: 0, error: String(err) };
  }
}

async function pruneAllHistories() {
  const results = await Promise.all([
    pruneJsonlFile(LOG_FILE),
    pruneJsonlFile(FALABELLA_HISTORY_FILE),
    pruneJsonlFile(WISE_HISTORY_FILE),
  ]);
  const totalRemoved = results.reduce((s, r) => s + (r.removed || 0), 0);
  if (totalRemoved > 0) {
    console.log(`[retention] purgados ${totalRemoved} entries más viejos que ${RETENTION_DAYS} días`);
  }
}

// Arrancar la purga al inicio y luego cada 24h
setTimeout(() => pruneAllHistories().catch(() => {}), 10 * 1000); // a los 10s del arranque
setInterval(() => pruneAllHistories().catch(() => {}), 24 * 3600 * 1000);

// ---------- fm-track ----------
function buildFmTrackUrl(relPath) {
  const slash = relPath.startsWith('/') ? '' : '/';
  const url = new URL(`${FM_TRACK_BASE_URL.replace(/\/$/, '')}${slash}${relPath}`);
  if (!url.searchParams.has('version')) url.searchParams.set('version', FM_TRACK_VERSION);
  url.searchParams.set('api_key', FM_TRACK_API_KEY);
  return url.toString();
}
async function callFmTrack(relPath) {
  const upstream = await fetch(buildFmTrackUrl(relPath), {
    headers: { Accept: 'application/json', 'X-Api-Key': FM_TRACK_API_KEY },
  });
  const text = await upstream.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: upstream.status, ok: upstream.ok, data: body };
}

// fm-track no tiene endpoint bulk de "last known position": hay que iterar /objects/{id}/coordinates
// con un rango fromDatetime/toDatetime y quedarse con el item más reciente.
const positionsCache = { fetchedAt: 0, byId: new Map(), objects: [] };
const POSITIONS_TTL_MS = 10000;
const COORDS_LOOKBACK_MIN = 60; // mira la última hora para encontrar la última posición

// Cache de grupos fm-track — cambian raramente, TTL más largo
const groupsCache = { fetchedAt: 0, groups: [] };
const GROUPS_TTL_MS = 30000;
async function ensureGroupsCache() {
  if (Date.now() - groupsCache.fetchedAt < GROUPS_TTL_MS) return;
  try {
    const r = await callFmTrack('/object-groups');
    if (!r.ok) return;
    const items = toArray(r.data?.items ?? r.data);
    groupsCache.groups = items.map((g) => ({
      id: String(g.id), name: String(g.name || ''),
      vehicles: Array.isArray(g.objects_ids) ? g.objects_ids.map(String) : [],
    }));
    groupsCache.fetchedAt = Date.now();
  } catch {}
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

async function fetchLatestCoordinate(objectId, lookbackMin = COORDS_LOOKBACK_MIN) {
  const to = new Date().toISOString();
  const from = new Date(Date.now() - lookbackMin * 60 * 1000).toISOString();
  const path = `/objects/${encodeURIComponent(objectId)}/coordinates?fromDatetime=${encodeURIComponent(from)}&toDatetime=${encodeURIComponent(to)}`;
  const r = await callFmTrack(path);
  if (!r.ok) return null;
  const items = toArray(r.data?.items ?? r.data);
  if (!items.length) return null;
  items.sort((a, b) => new Date(b.datetime || 0) - new Date(a.datetime || 0));
  return items[0];
}

async function refreshPositionsCache() {
  const objsRes = await callFmTrack('/objects');
  if (!objsRes.ok) throw new Error(`fm-track /objects → HTTP ${objsRes.status}`);
  positionsCache.objects = toArray(objsRes.data);

  const ids = positionsCache.objects
    .map((o) => pick(o, ['id', 'object_id', 'uuid', 'imei']))
    .filter(Boolean);

  const results = await Promise.allSettled(ids.map((id) => fetchLatestCoordinate(id).then((p) => [String(id), p])));

  positionsCache.byId = new Map();
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value && r.value[1]) {
      positionsCache.byId.set(r.value[0], r.value[1]);
    }
  }
  positionsCache.fetchedAt = Date.now();
}

async function ensurePositions() {
  if (Date.now() - positionsCache.fetchedAt > POSITIONS_TTL_MS) {
    await refreshPositionsCache();
  }
}

async function getPositionsForId(vehicleId) {
  await ensurePositions();
  const obj = positionsCache.objects.find((o) => String(pick(o, ['id', 'object_id', 'uuid', 'imei'])) === String(vehicleId));
  // Si la caché bulk no tiene posición, escalar la ventana: 1h → 24h → 7d
  let pos = positionsCache.byId.get(String(vehicleId));
  if (!pos) {
    for (const minutes of [COORDS_LOOKBACK_MIN, 24 * 60, 7 * 24 * 60]) {
      pos = await fetchLatestCoordinate(vehicleId, minutes);
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

// Rutas abiertas (no requieren login)
app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/favicon.ico', (_req, res) => res.status(204).end());

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

// Middleware: protege todo lo demás
app.use((req, res, next) => {
  if (!AUTH_ENABLED) return next();
  const user = verifyToken(getCookie(req, AUTH_COOKIE));
  if (user) { req.user = user; return next(); }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'no autenticado' });
  return res.redirect('/login');
});

app.use(express.static(path.join(__dirname, 'public')));

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
    const r = await callFmTrack('/object-groups/' + encodeURIComponent(req.params.id));
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
  const raw = await fs.readFile(LOG_FILE, 'utf8').catch(() => '');
  const entries = raw.trim().split('\n').filter(Boolean).slice(-limit).reverse()
    .map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  res.json({ entries });
});

// ===================== Falabella =====================
const appendFalabellaHistory = (e) => appendJsonl(FALABELLA_HISTORY_FILE, e);

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
  try { falabellaGroups = JSON.parse(await fs.readFile(FALABELLA_GROUPS_FILE, 'utf8')); }
  catch { falabellaGroups = {}; }
  // Migración: descartar entradas con id local (g_*) — ahora usamos ids de fm-track directamente.
  let dropped = 0;
  for (const k of Object.keys(falabellaGroups)) {
    if (k.startsWith('g_')) { delete falabellaGroups[k]; dropped++; }
  }
  if (dropped > 0) {
    console.log(`[migration] eliminadas ${dropped} entradas locales antiguas (ahora se usan ids de fm-track)`);
    await saveFalabellaGroups();
  }
}
async function saveFalabellaGroups() {
  await fs.writeFile(FALABELLA_GROUPS_FILE, JSON.stringify(falabellaGroups, null, 2), 'utf8');
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
    const r = await callFmTrack('/object-groups');
    if (!r.ok) return res.status(r.status).json({ error: 'fm-track devolvió ' + r.status, data: r.data });
    const items = toArray(r.data?.items ?? r.data);
    const groups = items.map((g) => ({
      id: String(g.id),
      name: String(g.name || ''),
      vehicles: Array.isArray(g.objects_ids) ? g.objects_ids.map(String) : [],
    })).filter(isGroupAllowed);
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
  delete falabellaGroups[String(req.params.id)];
  await saveFalabellaGroups();
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
  const raw = await fs.readFile(FALABELLA_HISTORY_FILE, 'utf8').catch(() => '');
  const entries = raw.trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .filter((e) => !groupId || String(e.groupId) === groupId)
    .slice(-limit).reverse();
  res.json({ entries });
});

// ===================== Wise (Wisetrack) =====================
const appendWiseHistory = (e) => appendJsonl(WISE_HISTORY_FILE, e);

let wiseGroups = {};
function defaultWiseGroupConfig() {
  // Wise exige >=20s entre llamadas; recomienda 30-60s para evento online (45). Default 30s.
  return { intervalSec: 30, enabled: false, lastRunAt: null, lastStatus: null, lastSummary: null };
}
async function loadWiseGroups() {
  try { wiseGroups = JSON.parse(await fs.readFile(WISE_GROUPS_FILE, 'utf8')); }
  catch { wiseGroups = {}; }
}
async function saveWiseGroups() {
  await fs.writeFile(WISE_GROUPS_FILE, JSON.stringify(wiseGroups, null, 2), 'utf8');
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
  // Wisetrack en Chile: enviar la hora en la zona horaria local (configurable via WISE_TIMEZONE).
  // Formato: yyyy-MM-dd HH:mm:ss (sin marcador de zona, como pide la doc).
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: WISE_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value || '00';
  // Algunos locales devuelven "24" para medianoche; normalizar a "00".
  const hh = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')} ${hh}:${get('minute')}:${get('second')}`;
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
  const patente = String(plateRaw || pick(obj, ['id']) || '').replace(/[^A-Za-z0-9-]/g, '').toUpperCase();
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
function parseWiseEstados(body) {
  if (!body || typeof body !== 'object') return [];
  const rop = body?.RespuestaServicioWeb?.RespuestaOperacion;
  if (Array.isArray(rop)) {
    return rop.map((o) => Number(o?.ResultadoTransaccion?.Estado)).filter(Number.isFinite);
  }
  const e = rop?.ResultadoTransaccion?.Estado;
  return e != null ? [Number(e)] : [];
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
    const estados = parseWiseEstados(body);
    const accepted = estados.length > 0 && estados.every((e) => e === 1);
    return {
      ok: r.ok,
      status: r.status,
      accepted,
      estados,
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
  try {
    const data = JSON.parse(await fs.readFile(WISE_BLOCKED_FILE, 'utf8'));
    wiseBlocked = new Set(data.vehicleIds || []);
  } catch { wiseBlocked = new Set(); }
}
async function saveWiseBlocked() {
  await fs.writeFile(WISE_BLOCKED_FILE, JSON.stringify({ vehicleIds: Array.from(wiseBlocked) }, null, 2), 'utf8');
}
await loadWiseBlocked();

// En memoria: último datetime enviado por vehículo (para dedupe — no re-inyectar la misma posición)
const wiseLastSentDatetime = new Map();

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
  const estados = batchResp.estados || [];

  // Distribuir el estado a cada vehículo (Wise responde en el mismo orden enviado)
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const estado = estados[i];
    const accepted = estado === 1;
    if (estado === 4) {
      // "No existe el móvil" → marcar como bloqueado y no reenviar más
      wiseBlocked.add(String(it.vehicleId));
    }
    if (accepted) {
      wiseLastSentDatetime.set(String(it.vehicleId), it.datetime);
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
  await saveWiseBlocked();
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
  if (req.body?.intervalSec != null) next.intervalSec = Math.max(5, Number(req.body.intervalSec) || 20);
  if (req.body?.enabled != null) next.enabled = Boolean(req.body.enabled);
  wiseGroups[id] = next;
  await saveWiseGroups();
  res.json(next);
});

app.delete('/api/wise/groups/:id', async (req, res) => {
  delete wiseGroups[String(req.params.id)];
  await saveWiseGroups();
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
  wiseBlocked.delete(String(req.params.id));
  await saveWiseBlocked();
  res.json({ ok: true });
});
app.post('/api/wise/blocked/clear', async (_req, res) => {
  wiseBlocked.clear();
  await saveWiseBlocked();
  res.json({ ok: true });
});

app.get('/api/wise/history', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const groupId = req.query.groupId ? String(req.query.groupId) : null;
  const raw = await fs.readFile(WISE_HISTORY_FILE, 'utf8').catch(() => '');
  const entries = raw.trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .filter((e) => !groupId || String(e.groupId) === groupId)
    .slice(-limit).reverse();
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

app.listen(PORT, () => {
  console.log(`track-service · http://localhost:${PORT}`);
  if (!FM_TRACK_API_KEY) console.warn('  ⚠  FM_TRACK_API_KEY no configurada');
  if (!FALABELLA_APIKEY || !FALABELLA_AUTHORIZATION) console.warn('  ⚠  Credenciales Falabella TEST no configuradas');
  if (!FALABELLA_PROD_APIKEY || !FALABELLA_PROD_AUTHORIZATION) console.warn('  ⚠  Credenciales Falabella PROD no configuradas');
  if (!WISE_API_TOKEN) console.warn('  ⚠  WISE_API_TOKEN no configurado');
  if (AUTH_ENABLED) {
    console.log(`  auth · ACTIVADA · ${AUTH_USERS.size} cuenta(s)`);
    if (!process.env.AUTH_SECRET) console.warn('  ⚠  AUTH_SECRET no definido — las sesiones se invalidan en cada reinicio. Define AUTH_SECRET en .env.');
  } else {
    console.warn('  ⚠  auth DESACTIVADA (sin AUTH_USERS) — la app es pública. Define AUTH_USERS en .env para protegerla.');
  }
  const activeFal = Object.values(falabellaGroups).filter((g) => g.enabled).length;
  const activeWise = Object.values(wiseGroups).filter((g) => g.enabled).length;
  console.log(`  scheduler Falabella · ${activeFal}/${Object.keys(falabellaGroups).length} grupos activos`);
  console.log(`  scheduler Wise · ${activeWise}/${Object.keys(wiseGroups).length} grupos activos`);
});
