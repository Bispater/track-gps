// =============================================================
// auth.js · login por cookie firmada (HMAC)
// =============================================================
// Cuentas en AUTH_USERS="usuario1:clave1,usuario2:clave2". Si está vacío, la auth queda
// DESACTIVADA. registerAuth() registra las rutas abiertas y luego el middleware que exige
// sesión: todo lo que se registre después queda protegido.
import crypto from 'node:crypto';
import { env } from './config.js';

const AUTH_COOKIE = 'track_session';
const AUTH_SESSION_HOURS = Number(env.AUTH_SESSION_HOURS || 12);
// Secret para firmar la cookie. Si no se define, se genera uno al arrancar
// (las sesiones se invalidan en cada reinicio — define AUTH_SECRET en prod).
const AUTH_SECRET = env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');
const AUTH_USERS = (() => {
  const map = new Map();
  for (const pair of (env.AUTH_USERS || '').split(',')) {
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

export function registerAuth(app) {
  // Rutas abiertas. El frontend (Angular) lo sirve Nginx en su propio contenedor;
  // este servicio expone SOLO la API y el login.
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
  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
    res.json({ ok: true });
  });
  app.get('/api/me', (req, res) => {
    const user = AUTH_ENABLED ? verifyToken(getCookie(req, AUTH_COOKIE)) : 'dev';
    res.json({ authEnabled: AUTH_ENABLED, authenticated: Boolean(user), username: user || null });
  });

  // Todo lo que se registre después exige sesión (API-only → 401 JSON si no hay)
  app.use((req, res, next) => {
    if (!AUTH_ENABLED) return next();
    const user = verifyToken(getCookie(req, AUTH_COOKIE));
    if (user) { req.user = user; return next(); }
    return res.status(401).json({ error: 'no autenticado' });
  });
}

export function logAuthStatus() {
  if (AUTH_ENABLED) {
    console.log(`  auth · ACTIVADA · ${AUTH_USERS.size} cuenta(s)`);
    if (!env.AUTH_SECRET) console.warn('  ⚠  AUTH_SECRET no definido — las sesiones se invalidan en cada reinicio. Define AUTH_SECRET en .env.');
  } else {
    console.warn('  ⚠  auth DESACTIVADA (sin AUTH_USERS) — la app es pública. Define AUTH_USERS en .env para protegerla.');
  }
}
