// =============================================================
// util.js · helpers compartidos (lectura de objetos fm-track, números, fechas, patentes)
// =============================================================

export function toArray(x) {
  if (Array.isArray(x)) return x;
  if (x && Array.isArray(x.items)) return x.items;
  if (x && Array.isArray(x.data)) return x.data;
  return x ? [x] : [];
}

// Primer valor no vacío entre varias rutas "a.b.c" del objeto
export function pick(o, paths, fb) {
  if (!o) return fb;
  for (const p of paths) {
    const v = p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
    if (v != null && v !== '') return v;
  }
  return fb;
}

// Ejecuta fn sobre items con a lo más `limit` promesas en vuelo. Misma forma que Promise.allSettled.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      try { results[i] = { status: 'fulfilled', value: await fn(items[i], i) }; }
      catch (reason) { results[i] = { status: 'rejected', reason }; }
    }
  });
  await Promise.all(workers);
  return results;
}

// Cuerpo de una respuesta fetch: JSON si se puede parsear, si no el texto tal cual
export async function readBody(r) {
  const text = await r.text();
  try { return JSON.parse(text); } catch { return text; }
}

// ---------- números ----------
export function clampInt(v, min, max, fb = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fb;
  return Math.max(min, Math.min(max, Math.round(n)));
}
export function round(v, dec, fb = null) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fb;
  const f = 10 ** dec;
  return Math.round(n * f) / f;
}

// ---------- patentes ----------
// Patente tal como viene de fm-track: plate_number si existe, si no el nombre del vehículo.
export const rawPlate = (obj) =>
  pick(obj, ['vehicle_params.plate_number', 'plate', 'license_plate']) || pick(obj, ['name']);
// Solo letras y dígitos, en mayúsculas: "ab-1234" → "AB1234"
export const plainPlate = (plate) => String(plate || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
// Guión entre letras y dígitos: "GKYS15" → "GKYS-15", "JL8953" → "JL-8953"
export function plateWithHyphen(plate) {
  const cleaned = String(plate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = cleaned.match(/^([A-Z]+)(\d+)$/);
  return m ? `${m[1]}-${m[2]}` : cleaned;
}

// ---------- fechas ----------
const pad = (n) => String(n).padStart(2, '0');

// "yyyy-MM-dd HH:mm:ss" en UTC (d debe ser una fecha válida)
export function formatUtc(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// Fecha y hora "de pared" en la zona horaria tz: { year, month, day, hour, minute, second } (strings)
export function localParts(d, tz) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d)) parts[p.type] = p.value;
  if (parts.hour === '24') parts.hour = '00';
  return parts;
}

// "yyyy-MM-dd HH:mm:ss" en hora local de tz, sin offset
export function formatLocal(d, tz) {
  const p = localParts(d, tz);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

// ISO 8601 con el offset local explícito (ej: 2026-05-26T14:21:41-04:00).
// Es el mismo instante; solo cambia la representación.
export function toIsoLocal(ts, tz) {
  const d = new Date(ts || Date.now());
  if (isNaN(d.getTime())) return new Date().toISOString();
  const p = localParts(d, tz);
  // Offset en minutos: el "reloj de pared" en tz leído como UTC, menos el instante real
  const asUtcMs = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const offsetMin = Math.round((asUtcMs - d.getTime()) / 60000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const absMin = Math.abs(offsetMin);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${pad(Math.floor(absMin / 60))}:${pad(absMin % 60)}`;
}
