// =============================================================
// api-externa.js · API de solo lectura para clientes (panel → Accesos API)
// =============================================================
// Un cliente consulta la última posición de las patentes que se le autorizaron:
//   GET /api/externo/v1/posiciones                     todas sus patentes
//   GET /api/externo/v1/posiciones?patente=AB1234,CD5678   solo esas (las no autorizadas se ignoran)
// Credenciales (se crean en el panel): usuario + token. Se aceptan:
//   Authorization: Bearer <token>
//   Authorization: Basic base64(usuario:token)     (usuario y contraseña; la contraseña es el token)
//   X-API-Key: <token>
// Responde con lo que el recolector de fm-track ya tiene en RAM: no genera consultas a
// fm-track. Fechas en hora de Chile con su offset (ISO 8601, ej. 2026-11-11T12:42:10-03:00).
// El token se guarda como hash SHA-256 y se muestra una sola vez (al crearlo o regenerarlo).
import crypto from 'node:crypto';
import * as db from './db.js';
import { ensurePositions, getLatestPositions } from './fmtrack.js';
import { pick, rawPlate, plainPlate, toIsoLocal } from './util.js';

export const EXTERNAL_PATH = '/api/externo/v1/posiciones';
const TZ = 'America/Santiago';
const DEFAULT_LIMIT_PER_MIN = 2;
const USUARIO_RE = /^[a-z0-9][a-z0-9._-]{2,39}$/;

// ---------- accesos en memoria (se recargan de la base tras cada cambio) ----------
let byHash = new Map(); // sha256(token) → fila de api_access
let byId = new Map();   // id → fila
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const newToken = () => 'psg_' + crypto.randomBytes(24).toString('base64url');

async function reload() {
  const rows = await db.listApiAccess();
  byHash = new Map(rows.map((r) => [r.token_hash, r]));
  byId = new Map(rows.map((r) => [String(r.id), r]));
}
export async function initApiAccess() {
  try {
    await reload();
    if (byId.size) console.log(`  api externa · ${byId.size} acceso(s) configurado(s)`);
  } catch (err) {
    console.warn('[api-externa] no se pudieron cargar los accesos:', String(err));
  }
}

// ---------- respuesta ----------
const num = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const posTs = (p) => (p ? Date.parse(p.datetime) : -Infinity);

function toVehiculo(patente, pos) {
  const lat = num(pick(pos, ['position.latitude']));
  const lng = num(pick(pos, ['position.longitude']));
  const t = posTs(pos);
  const valid = lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
    && !(lat === 0 && lng === 0) && Number.isFinite(t);
  if (!valid) return { patente, latitud: null, longitud: null, fecha_hora: null, velocidad: null, ignicion: null };
  const speed = num(pick(pos, ['position.speed']));
  const ign = pick(pos, ['ignition_status']);
  return {
    patente,
    latitud: lat,
    longitud: lng,
    fecha_hora: toIsoLocal(t, TZ),
    velocidad: speed != null ? Math.max(0, Math.round(speed)) : null, // km/h
    ignicion: ign === 'ON' ? true : ign === 'OFF' ? false : null,
  };
}

// Patente → vehículo con su último punto. Si dos vehículos tienen la misma patente, el de
// punto más nuevo.
function vehiclesByPlate() {
  const out = new Map();
  for (const v of getLatestPositions()) {
    const plate = plainPlate(rawPlate(v.obj));
    if (!plate) continue;
    const prev = out.get(plate);
    if (!prev || posTs(v.pos) > posTs(prev.pos)) out.set(plate, v);
  }
  return out;
}

// Todas las patentes autorizadas, ordenadas; las que no tienen posición de los últimos
// 7 días (o no existen en fm-track) van con los datos en null.
function buildBody(patentes, filtro = null) {
  const byPlate = vehiclesByPlate();
  const vehiculos = [...patentes]
    .filter((p) => !filtro || filtro.has(p))
    .sort()
    .map((p) => toVehiculo(p, byPlate.get(p)?.pos || null));
  return { fecha_consulta: toIsoLocal(Date.now(), TZ), total: vehiculos.length, vehiculos };
}

// ---------- autenticación y límite ----------
function credentials(req) {
  const h = String(req.headers.authorization || '').trim();
  const m = h.match(/^(\S+)\s+(.+)$/);
  if (m && /^bearer$/i.test(m[1])) return { token: m[2].trim() };
  if (m && /^basic$/i.test(m[1])) {
    const dec = Buffer.from(m[2].trim(), 'base64').toString('utf8');
    const i = dec.indexOf(':');
    if (i > 0) return { usuario: dec.slice(0, i).trim().toLowerCase(), token: dec.slice(i + 1) };
    return null;
  }
  const k = req.headers['x-api-key'];
  return k ? { token: String(k).trim() } : null;
}
function authenticate(req) {
  const c = credentials(req);
  if (!c?.token) return null;
  const acc = byHash.get(hashToken(c.token));
  if (!acc) return null;
  if (c.usuario != null && c.usuario !== acc.usuario) return null;
  return acc;
}
// IP real del cliente (Caddy agrega X-Forwarded-For)
const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || null;

// Ventana móvil de 60 s por acceso: hasta limite_minuto consultas respondidas
const windows = new Map(); // id → [epoch ms]
function rateCheck(acc) {
  const now = Date.now();
  const w = (windows.get(String(acc.id)) || []).filter((t) => t > now - 60000);
  windows.set(String(acc.id), w);
  if (w.length >= acc.limite_minuto) return Math.max(1, Math.ceil((w[0] + 60000 - now) / 1000));
  w.push(now);
  return 0;
}

// Rutas públicas: se registran ANTES del login del panel (autentican con su propio token)
export function registerExternalApi(app) {
  app.get(EXTERNAL_PATH, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const acc = authenticate(req);
    if (!acc) {
      res.setHeader('WWW-Authenticate', 'Basic realm="PROASEG API", charset="UTF-8"');
      return res.status(401).json({ error: 'credenciales inválidas' });
    }
    if (!acc.enabled) return res.status(403).json({ error: 'acceso desactivado' });
    const wait = rateCheck(acc);
    if (wait) {
      db.recordApiAccessUse(acc.id, null, true).catch(() => {});
      res.setHeader('Retry-After', String(wait));
      return res.status(429).json({ error: `máximo ${acc.limite_minuto} consulta(s) por minuto; reintentar en ${wait} s` });
    }
    try {
      await ensurePositions();
      const q = typeof req.query.patente === 'string' ? req.query.patente : null;
      const filtro = q ? new Set(q.split(',').map(plainPlate).filter(Boolean)) : null;
      res.json(buildBody(acc.patentes, filtro));
      db.recordApiAccessUse(acc.id, clientIp(req), false).catch(() => {});
    } catch (err) {
      res.status(500).json({ error: 'error interno' });
      console.warn('[api-externa] error:', String(err));
    }
  });
}

// ---------- administración (panel; exige sesión) ----------
const publicAccess = (a) => ({
  id: String(a.id),
  nombre: a.nombre,
  usuario: a.usuario,
  tokenFin: a.token_fin,
  patentes: a.patentes || [],
  limiteMinuto: a.limite_minuto,
  enabled: a.enabled,
  createdAt: a.created_at?.toISOString?.() ?? null,
  createdBy: a.created_by,
  updatedAt: a.updated_at?.toISOString?.() ?? null,
  lastUsedAt: a.last_used_at?.toISOString?.() ?? null,
  lastIp: a.last_ip,
  consultas: Number(a.consultas || 0),
  limitadas: Number(a.limitadas || 0),
});

class InputError extends Error {}
function parseInput(body, creating) {
  const b = body || {};
  const out = {};
  if (creating || b.nombre !== undefined) {
    const nombre = String(b.nombre ?? '').trim();
    if (!nombre || nombre.length > 80) throw new InputError('nombre: entre 1 y 80 caracteres');
    out.nombre = nombre;
  }
  if (creating) {
    const usuario = String(b.usuario ?? '').trim().toLowerCase();
    if (!USUARIO_RE.test(usuario)) throw new InputError('usuario: 3 a 40 caracteres (minúsculas, números, punto, guion o guion bajo)');
    out.usuario = usuario;
  }
  if (creating || b.patentes !== undefined) {
    if (!Array.isArray(b.patentes)) throw new InputError('patentes: debe ser una lista');
    const set = [...new Set(b.patentes.map(plainPlate).filter(Boolean))].sort();
    if (set.length > 1000) throw new InputError('patentes: máximo 1000');
    const long = set.find((p) => p.length > 40);
    if (long) throw new InputError('patente demasiado larga: ' + long);
    out.patentes = set;
  }
  if (creating || b.limiteMinuto !== undefined) {
    const n = b.limiteMinuto === undefined ? DEFAULT_LIMIT_PER_MIN : Number(b.limiteMinuto);
    if (!Number.isInteger(n) || n < 1 || n > 60) throw new InputError('limiteMinuto: entero entre 1 y 60');
    out.limiteMinuto = n;
  }
  if (!creating && b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') throw new InputError('enabled: true o false');
    out.enabled = b.enabled;
  }
  return out;
}
function fail(res, err) {
  if (err instanceof InputError) return res.status(400).json({ error: err.message });
  if (err?.code === '23505') return res.status(409).json({ error: 'ese usuario ya existe' });
  return res.status(500).json({ error: String(err) });
}
const audit = (accion, acc, req, extra = {}) =>
  db.appendActivity({ kind: 'api_access', accion, usuario: acc?.usuario, por: req.user || null, ...extra }).catch(() => {});
const validId = (id) => /^\d{1,18}$/.test(String(id));

export function registerApiAccessRoutes(app) {
  app.get('/api/accesos', async (_req, res) => {
    try {
      res.json({ accesos: (await db.listApiAccess()).map(publicAccess), endpoint: EXTERNAL_PATH });
    } catch (err) { fail(res, err); }
  });

  // Patentes que reconoce el backend (misma regla que la API) para elegirlas en el panel
  app.get('/api/accesos/vehiculos', async (_req, res) => {
    try {
      await ensurePositions();
      res.json({
        vehiculos: getLatestPositions().map((v) => ({
          id: v.id,
          patente: plainPlate(rawPlate(v.obj)),
          nombre: String(pick(v.obj, ['name'], '')),
          fechaHora: v.pos ? toIsoLocal(posTs(v.pos), TZ) : null,
        })),
      });
    } catch (err) { fail(res, err); }
  });

  app.post('/api/accesos', async (req, res) => {
    try {
      const c = parseInput(req.body, true);
      const token = newToken();
      const row = await db.insertApiAccess({ ...c, tokenHash: hashToken(token), tokenFin: token.slice(-4), createdBy: req.user || null });
      await reload();
      audit('crear', row, req, { patentes: row.patentes.length });
      res.json({ acceso: publicAccess(row), token });
    } catch (err) { fail(res, err); }
  });

  app.put('/api/accesos/:id', async (req, res) => {
    if (!validId(req.params.id)) return res.status(404).json({ error: 'no existe' });
    try {
      const c = parseInput(req.body, false);
      const row = await db.updateApiAccess(req.params.id, c);
      if (!row) return res.status(404).json({ error: 'no existe' });
      await reload();
      audit('editar', row, req, { cambios: Object.keys(c) });
      res.json({ acceso: publicAccess(row) });
    } catch (err) { fail(res, err); }
  });

  // Token nuevo: el anterior deja de funcionar al instante
  app.post('/api/accesos/:id/token', async (req, res) => {
    if (!validId(req.params.id)) return res.status(404).json({ error: 'no existe' });
    try {
      const token = newToken();
      const row = await db.setApiAccessToken(req.params.id, hashToken(token), token.slice(-4));
      if (!row) return res.status(404).json({ error: 'no existe' });
      await reload();
      audit('regenerar_token', row, req);
      res.json({ acceso: publicAccess(row), token });
    } catch (err) { fail(res, err); }
  });

  app.delete('/api/accesos/:id', async (req, res) => {
    if (!validId(req.params.id)) return res.status(404).json({ error: 'no existe' });
    try {
      const acc = byId.get(String(req.params.id));
      if (!(await db.deleteApiAccess(req.params.id))) return res.status(404).json({ error: 'no existe' });
      await reload();
      audit('eliminar', acc, req);
      res.json({ ok: true });
    } catch (err) { fail(res, err); }
  });

  // Lo que el cliente recibe ahora mismo (sin contar como consulta ni aplicar el límite)
  app.get('/api/accesos/:id/preview', async (req, res) => {
    const acc = byId.get(String(req.params.id));
    if (!acc) return res.status(404).json({ error: 'no existe' });
    try {
      await ensurePositions();
      res.json(buildBody(acc.patentes));
    } catch (err) { fail(res, err); }
  });
}
