// =============================================================
// config.js · configuración general desde variables de entorno
// =============================================================
// Todo módulo que lea process.env importa `env` desde aquí: así dotenv ya cargó el .env
// antes de que se lea cualquier variable, sin importar el orden de los imports.
// Las variables propias de cada destino (WISE_*, BERMANN_*, …) se leen en su módulo
// dentro de src/integrations/.
import 'dotenv/config';

export const env = process.env;

// Limpia llaves/espacios que muchas veces se pegan con el placeholder de la doc
export const cleanKey = (s) => (s || '').trim().replace(/^[{<\[]+|[}>\]]+$/g, '');

export const PORT = env.PORT ?? 3000;

// ---------- fm-track ----------
export const FM_TRACK_BASE_URL = env.FM_TRACK_BASE_URL ?? 'https://api.fm-track.com';
export const FM_TRACK_VERSION = env.FM_TRACK_VERSION ?? '1';
export const FM_TRACK_API_KEY = cleanKey(env.FM_TRACK_API_KEY);
// Multi-tenant: hasta 4 claves adicionales (FM_TRACK_API_KEY_2, _3, _4, _5)
export const FM_TRACK_API_KEYS = [
  FM_TRACK_API_KEY,
  cleanKey(env.FM_TRACK_API_KEY_2),
  cleanKey(env.FM_TRACK_API_KEY_3),
  cleanKey(env.FM_TRACK_API_KEY_4),
  cleanKey(env.FM_TRACK_API_KEY_5),
].filter(Boolean);

// ---------- reenvío genérico (/api/forward) ----------
export const TARGET_API_URL = env.TARGET_API_URL ?? '';
export const TARGET_API_KEY = env.TARGET_API_KEY ?? '';

// ---------- retención ----------
// send_history y activity_log se purgan pasados RETENTION_DAYS; las posiciones GPS
// guardadas (historial del mapa) tienen su propia retención.
export const RETENTION_DAYS = Math.max(1, Number(env.RETENTION_DAYS || 15));
export const POSITION_RETENTION_DAYS = Math.max(1, Number(env.POSITION_RETENTION_DAYS || 15));

// ---------- whitelist de grupos fm-track ----------
// Lista "nombre o id" separada por comas. Vacía = todos los grupos.
export const ALLOWED_GROUPS = env.ALLOWED_GROUPS ?? '';
export function groupFilter(raw) {
  const set = new Set((raw || '').split(',').map((s) => s.trim()).filter(Boolean));
  return (g) => set.size === 0 || set.has(g.name) || set.has(g.id);
}
export const isGroupAllowed = groupFilter(ALLOWED_GROUPS);
