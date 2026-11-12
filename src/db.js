// =============================================================
// db.js · capa de persistencia Postgres
// =============================================================
// Reemplaza el storage en archivos planos (logs/*.jsonl, *-groups.json).
// Todo el estado del concentrador vive ahora en Postgres:
//   - group_config     → config de envío por cliente+grupo (intervalo, enabled, etc.)
//   - send_history     → historial de envíos por cliente (lo que iban a los *-history.jsonl)
//   - activity_log     → log general (lo que iba a activity.jsonl)
//   - blocked_vehicle  → vehículos bloqueados por cliente (ej: Wise estado 4)
//   - position_history → posiciones GPS tal como llegan de fm-track (alimenta el historial
//                        del mapa sin volver a consultar fm-track)
//
// La cache de fm-track (objects/positions/groups) NO se persiste: vive en RAM
// porque es solo un espejo TTL de la API de fm-track.
import pg from 'pg';
import { env } from './config.js';

const { Pool } = pg;

// pg lee DATABASE_URL automáticamente, o las vars PG* (PGHOST, PGUSER, …).
const pool = new Pool(
  env.DATABASE_URL ? { connectionString: env.DATABASE_URL } : {}
);

pool.on('error', (err) => {
  console.error('[db] error inesperado en cliente idle:', err.message);
});

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS group_config (
  client       TEXT        NOT NULL,
  group_id     TEXT        NOT NULL,
  interval_sec INTEGER     NOT NULL DEFAULT 30,
  enabled      BOOLEAN     NOT NULL DEFAULT FALSE,
  env          TEXT,
  x_country    TEXT,
  provider     JSONB,
  last_run_at  TIMESTAMPTZ,
  last_status  TEXT,
  last_summary JSONB,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (client, group_id)
);

CREATE TABLE IF NOT EXISTS send_history (
  id         BIGSERIAL   PRIMARY KEY,
  client     TEXT        NOT NULL,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
  group_id   TEXT,
  vehicle_id TEXT,
  ok         BOOLEAN,
  accepted   BOOLEAN,
  status     INTEGER,
  entry      JSONB       NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_send_history_client_ts ON send_history (client, ts DESC);
CREATE INDEX IF NOT EXISTS idx_send_history_group     ON send_history (client, group_id, ts DESC);
-- skipped como columna real (antes solo dentro del JSONB → las métricas parseaban cada fila)
ALTER TABLE send_history ADD COLUMN IF NOT EXISTS skipped BOOLEAN NOT NULL DEFAULT false;

-- Agregados por hora de send_history para el dashboard de métricas. Los mantiene
-- rollupSendStats(): recalcula las últimas horas cada minuto. Leer de aquí es
-- instantáneo; antes cada carga de Métricas recorría toda la tabla send_history.
CREATE TABLE IF NOT EXISTS send_stats_hourly (
  bucket     TIMESTAMPTZ NOT NULL,
  client     TEXT        NOT NULL,
  total      INTEGER     NOT NULL DEFAULT 0,
  aceptados  INTEGER     NOT NULL DEFAULT 0,
  rechazados INTEGER     NOT NULL DEFAULT 0,
  errores    INTEGER     NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket, client)
);
-- Vehículos con al menos un envío aceptado por hora y cliente (KPI "vehículos reportando")
CREATE TABLE IF NOT EXISTS send_stats_vehicle_hourly (
  bucket     TIMESTAMPTZ NOT NULL,
  client     TEXT        NOT NULL,
  vehicle_id TEXT        NOT NULL,
  PRIMARY KEY (bucket, client, vehicle_id)
);
-- Errores agrupados por hora cerrada (cliente, vehículo, código, mensaje) para las tarjetas
-- "Errores más comunes" y "Vehículos con fallos". Antes se leían de send_history: con
-- 7 días eran ~200 mil filas con su JSON completo y cada carga tardaba ~30 s.
-- detalle = mensaje normalizado (números largos → #); ultimo_detalle = mensaje completo
-- del error más reciente del grupo. Los mantiene rollupSendErrors().
CREATE TABLE IF NOT EXISTS send_errors_hourly (
  bucket         TIMESTAMPTZ NOT NULL,
  client         TEXT        NOT NULL,
  vehicle_id     TEXT,
  status         INTEGER,
  detalle        TEXT        NOT NULL,
  fallos         INTEGER     NOT NULL,
  ultimo         TIMESTAMPTZ NOT NULL,
  ultimo_detalle TEXT        NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_send_errors_hourly_bucket ON send_errors_hourly (bucket);
CREATE INDEX IF NOT EXISTS idx_send_errors_hourly_client ON send_errors_hourly (client, bucket);
-- Marcas de mantenimiento (ej: backfill ya ejecutado)
CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS activity_log (
  id    BIGSERIAL   PRIMARY KEY,
  ts    TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind  TEXT,
  entry JSONB       NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity_log (ts DESC);

CREATE TABLE IF NOT EXISTS blocked_vehicle (
  client     TEXT        NOT NULL,
  vehicle_id TEXT        NOT NULL,
  reason     TEXT,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (client, vehicle_id)
);

-- Posiciones GPS crudas por vehículo. Se llenan con lo que el refresh de fm-track ya trae
-- (últimos 60 min de cada vehículo cada 10 s) → el historial del mapa se sirve desde aquí.
CREATE TABLE IF NOT EXISTS position_history (
  vehicle_id TEXT             NOT NULL,
  ts         TIMESTAMPTZ      NOT NULL,
  lat        DOUBLE PRECISION NOT NULL,
  lng        DOUBLE PRECISION NOT NULL,
  speed      REAL,
  direction  REAL,
  ignition   SMALLINT,
  odometer   DOUBLE PRECISION,
  PRIMARY KEY (vehicle_id, ts)
);

-- Último datetime de posición enviado y ACEPTADO por vehículo, para no reinyectar
-- la misma posición (sobrevive a reinicios). Lo exige el spec de Wisetrack.
CREATE TABLE IF NOT EXISTS last_sent (
  client     TEXT        NOT NULL,
  vehicle_id TEXT        NOT NULL,
  datetime   TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (client, vehicle_id)
);

-- Accesos API (src/api-externa.js): credenciales de solo lectura para que un cliente
-- consulte la última posición de las patentes autorizadas. El token se guarda como hash
-- SHA-256 (se muestra una sola vez); token_fin = últimos 4 caracteres para reconocerlo.
CREATE TABLE IF NOT EXISTS api_access (
  id            BIGSERIAL   PRIMARY KEY,
  nombre        TEXT        NOT NULL,
  usuario       TEXT        NOT NULL UNIQUE,
  token_hash    TEXT        NOT NULL UNIQUE,
  token_fin     TEXT        NOT NULL,
  patentes      TEXT[]      NOT NULL DEFAULT '{}',
  limite_minuto INTEGER     NOT NULL DEFAULT 2,
  enabled       BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  last_ip       TEXT,
  consultas     BIGINT      NOT NULL DEFAULT 0,
  limitadas     BIGINT      NOT NULL DEFAULT 0
);

-- Registro de consultas a la API externa, respondidas y rechazadas. access_id NULL = no se
-- pudo identificar el acceso (token desconocido o sin credenciales). Se purga a los 90 días.
CREATE TABLE IF NOT EXISTS api_access_log (
  id           BIGSERIAL   PRIMARY KEY,
  ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
  access_id    BIGINT      REFERENCES api_access(id) ON DELETE CASCADE,
  usuario      TEXT,
  ip           TEXT,
  metodo       TEXT,
  status       SMALLINT    NOT NULL,
  resultado    TEXT        NOT NULL,
  vehiculos    INTEGER,
  con_posicion INTEGER,
  filtro       TEXT,
  token_fin    TEXT,
  user_agent   TEXT,
  ms           INTEGER
);
CREATE INDEX IF NOT EXISTS idx_api_access_log_access ON api_access_log (access_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_api_access_log_ts ON api_access_log (ts);
`;

// Espera a que Postgres esté disponible (en Docker el backend arranca antes que la DB
// esté lista) y luego crea las tablas si no existen.
export async function initDb({ retries = 30, delayMs = 2000 } = {}) {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (err) {
      if (i === retries - 1) {
        throw new Error(`[db] no se pudo conectar a Postgres tras ${retries} intentos: ${err.message}`);
      }
      console.log(`[db] esperando Postgres… (${i + 1}/${retries})`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  await pool.query(SCHEMA_SQL);
  console.log('[db] schema listo');
}

// ---------- activity_log ----------
export async function appendActivity(entry) {
  await pool.query('INSERT INTO activity_log (kind, entry) VALUES ($1, $2)', [entry?.kind ?? null, entry ?? {}]);
}
export async function getActivity(limit = 100) {
  const { rows } = await pool.query(
    'SELECT ts, entry FROM activity_log ORDER BY ts DESC LIMIT $1',
    [limit]
  );
  return rows.map((r) => ({ ...r.entry, ts: r.ts.toISOString() }));
}

// ---------- send_history ----------
export async function appendHistory(client, entry) {
  await pool.query(
    `INSERT INTO send_history (client, group_id, vehicle_id, ok, accepted, status, skipped, entry)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      client,
      entry?.groupId ?? null,
      entry?.vehicleId != null ? String(entry.vehicleId) : null,
      typeof entry?.ok === 'boolean' ? entry.ok : null,
      typeof entry?.accepted === 'boolean' ? entry.accepted : null,
      Number.isFinite(entry?.status) ? entry.status : null,
      Boolean(entry?.skipped),
      entry ?? {},
    ]
  );
}

// ---------- mantenimiento de métricas ----------
export async function getMeta(key) {
  const { rows } = await pool.query('SELECT value FROM app_meta WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}
export async function setMeta(key, value) {
  await pool.query(
    'INSERT INTO app_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, value == null ? null : String(value)]
  );
}
// Índices por fecha. CONCURRENTLY no bloquea las escrituras del scheduler mientras se
// construye, pero no puede ir dentro de una transacción → una sentencia por query.
export async function ensureIndexes() {
  const stmts = [
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_send_history_ts ON send_history (ts DESC)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_send_history_fail_ts ON send_history (ts DESC) WHERE ok IS NOT TRUE',
  ];
  for (const sql of stmts) await pool.query(sql);
}
// Marca skipped=true en las filas viejas que lo traían solo dentro del JSONB. Por lotes de
// una hora (usa el índice por ts) para no bloquear la tabla.
export async function backfillSkipped(days) {
  let updated = 0;
  const end = Date.now();
  for (let t = end - days * 86400e3; t < end; t += 3600e3) {
    const r = await pool.query(
      `UPDATE send_history SET skipped = true
        WHERE ts >= $1 AND ts < $2 AND skipped = false AND (entry->>'skipped')::boolean`,
      [new Date(t), new Date(t + 3600e3)]
    );
    updated += r.rowCount || 0;
    await new Promise((res) => setTimeout(res, 30));
  }
  return updated;
}
// Recalcula los agregados por hora desde `sinceHours` atrás (upsert por bucket+cliente).
export async function rollupSendStats({ sinceHours = 2 } = {}) {
  const from = `date_trunc('hour', now() - make_interval(hours => $1))`;
  await pool.query(
    `INSERT INTO send_stats_hourly (bucket, client, total, aceptados, rechazados, errores, updated_at)
     SELECT date_trunc('hour', ts), client,
            count(*)::int,
            count(*) FILTER (WHERE accepted)::int,
            count(*) FILTER (WHERE ok AND accepted IS NOT TRUE)::int,
            count(*) FILTER (WHERE ok IS NOT TRUE)::int,
            now()
       FROM send_history
      WHERE ts >= ${from} AND skipped = false
      GROUP BY 1, 2
     ON CONFLICT (bucket, client) DO UPDATE SET
       total = EXCLUDED.total, aceptados = EXCLUDED.aceptados, rechazados = EXCLUDED.rechazados,
       errores = EXCLUDED.errores, updated_at = now()`,
    [sinceHours]
  );
  await pool.query(
    `INSERT INTO send_stats_vehicle_hourly (bucket, client, vehicle_id)
     SELECT DISTINCT date_trunc('hour', ts), client, vehicle_id
       FROM send_history
      WHERE ts >= ${from} AND accepted AND vehicle_id IS NOT NULL
     ON CONFLICT DO NOTHING`,
    [sinceHours]
  );
}
// Recalcula los errores agrupados de las horas cerradas en [from, to) (borra y vuelve a
// insertar en una transacción: quien lee ve la versión anterior o la nueva, nunca a medias).
export async function rollupSendErrors(from, to) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('DELETE FROM send_errors_hourly WHERE bucket >= $1 AND bucket < $2', [from, to]);
    await c.query(
      `INSERT INTO send_errors_hourly (bucket, client, vehicle_id, status, detalle, fallos, ultimo, ultimo_detalle)
       SELECT date_trunc('hour', ts), client, vehicle_id, status, ${ERROR_NORM_SQL('det')},
              count(*)::int, max(ts), (array_agg(det ORDER BY ts DESC))[1]
         FROM (SELECT ts, client, vehicle_id, status, ${ERROR_DETAIL_SQL} AS det
                 FROM send_history WHERE ts >= $1 AND ts < $2 AND ok IS NOT TRUE) s
        GROUP BY 1, 2, 3, 4, 5`,
      [from, to]
    );
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}
// Última hora agrupada (null = tabla vacía)
export async function getErrorsCoverage() {
  const { rows } = await pool.query('SELECT max(bucket) AS last_bucket FROM send_errors_hourly');
  return rows[0]?.last_bucket || null;
}
export async function getStatsCoverage() {
  const { rows } = await pool.query('SELECT max(bucket) AS last_bucket, max(updated_at) AS updated_at, count(*)::int AS n FROM send_stats_hourly');
  return { lastBucket: rows[0]?.last_bucket || null, updatedAt: rows[0]?.updated_at || null, n: rows[0]?.n || 0 };
}
export async function getHistory(client, { limit = 200, groupId = null } = {}) {
  const params = [client];
  let sql = 'SELECT ts, entry FROM send_history WHERE client = $1';
  if (groupId) {
    params.push(groupId);
    sql += ` AND group_id = $${params.length}`;
  }
  params.push(limit);
  sql += ` ORDER BY ts DESC LIMIT $${params.length}`;
  const { rows } = await pool.query(sql, params);
  return rows.map((r) => ({ ...r.entry, ts: r.ts.toISOString() }));
}

// ---------- group_config ----------
export async function loadGroupConfigs(client) {
  const { rows } = await pool.query('SELECT * FROM group_config WHERE client = $1', [client]);
  const map = {};
  for (const r of rows) {
    const c = {
      intervalSec: r.interval_sec,
      enabled: r.enabled,
      lastRunAt: r.last_run_at ? r.last_run_at.toISOString() : null,
      lastStatus: r.last_status ?? null,
      lastSummary: r.last_summary ?? null,
    };
    if (r.env != null) c.env = r.env;
    if (r.x_country != null) c.x_country = r.x_country;
    if (r.provider != null) c.provider = r.provider;
    map[r.group_id] = c;
  }
  return map;
}
export async function saveGroupConfig(client, groupId, c) {
  await pool.query(
    `INSERT INTO group_config
       (client, group_id, interval_sec, enabled, env, x_country, provider, last_run_at, last_status, last_summary, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (client, group_id) DO UPDATE SET
       interval_sec = EXCLUDED.interval_sec,
       enabled      = EXCLUDED.enabled,
       env          = EXCLUDED.env,
       x_country    = EXCLUDED.x_country,
       provider     = EXCLUDED.provider,
       last_run_at  = EXCLUDED.last_run_at,
       last_status  = EXCLUDED.last_status,
       last_summary = EXCLUDED.last_summary,
       updated_at   = now()`,
    [
      client,
      groupId,
      Number.isFinite(c?.intervalSec) ? c.intervalSec : 30,
      Boolean(c?.enabled),
      c?.env ?? null,
      c?.x_country ?? null,
      c?.provider ?? null,
      c?.lastRunAt ? new Date(c.lastRunAt) : null,
      c?.lastStatus ?? null,
      c?.lastSummary ?? null,
    ]
  );
}
// Persiste todo el mapa en memoria (upsert por fila). Se usa tras los ticks de scheduler.
export async function saveGroupConfigs(client, map) {
  for (const [groupId, c] of Object.entries(map || {})) {
    await saveGroupConfig(client, groupId, c);
  }
}
export async function deleteGroupConfig(client, groupId) {
  await pool.query('DELETE FROM group_config WHERE client = $1 AND group_id = $2', [client, groupId]);
}

// ---------- blocked_vehicle ----------
export async function loadBlocked(client) {
  const { rows } = await pool.query('SELECT vehicle_id FROM blocked_vehicle WHERE client = $1', [client]);
  return new Set(rows.map((r) => r.vehicle_id));
}
export async function addBlocked(client, vehicleId, reason) {
  await pool.query(
    'INSERT INTO blocked_vehicle (client, vehicle_id, reason) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [client, String(vehicleId), reason ?? null]
  );
}
export async function removeBlocked(client, vehicleId) {
  await pool.query('DELETE FROM blocked_vehicle WHERE client = $1 AND vehicle_id = $2', [client, String(vehicleId)]);
}
export async function clearBlocked(client) {
  await pool.query('DELETE FROM blocked_vehicle WHERE client = $1', [client]);
}

// ---------- last_sent (dedupe persistente) ----------
export async function loadLastSent(client) {
  const { rows } = await pool.query('SELECT vehicle_id, datetime FROM last_sent WHERE client = $1', [client]);
  const map = new Map();
  for (const r of rows) map.set(r.vehicle_id, r.datetime);
  return map;
}
export async function saveLastSent(client, vehicleId, datetime) {
  await pool.query(
    `INSERT INTO last_sent (client, vehicle_id, datetime, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (client, vehicle_id) DO UPDATE SET datetime = EXCLUDED.datetime, updated_at = now()`,
    [client, String(vehicleId), datetime ?? null]
  );
}

// ---------- api_access (Accesos API) ----------
const API_ACCESS_COLS = `id, nombre, usuario, token_hash, token_fin, patentes, limite_minuto, enabled,
  created_at, created_by, updated_at, last_used_at, last_ip, consultas, limitadas`;
export async function listApiAccess() {
  const { rows } = await pool.query(`SELECT ${API_ACCESS_COLS} FROM api_access ORDER BY created_at`);
  return rows;
}
export async function insertApiAccess({ nombre, usuario, tokenHash, tokenFin, patentes, limiteMinuto, createdBy }) {
  const { rows } = await pool.query(
    `INSERT INTO api_access (nombre, usuario, token_hash, token_fin, patentes, limite_minuto, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${API_ACCESS_COLS}`,
    [nombre, usuario, tokenHash, tokenFin, patentes, limiteMinuto, createdBy ?? null]
  );
  return rows[0];
}
// Solo cambia los campos presentes en `c` (nombre, patentes, limiteMinuto, enabled)
export async function updateApiAccess(id, c) {
  const { rows } = await pool.query(
    `UPDATE api_access SET
       nombre = COALESCE($2, nombre),
       patentes = COALESCE($3, patentes),
       limite_minuto = COALESCE($4, limite_minuto),
       enabled = COALESCE($5, enabled),
       updated_at = now()
     WHERE id = $1 RETURNING ${API_ACCESS_COLS}`,
    [id, c.nombre ?? null, c.patentes ?? null, c.limiteMinuto ?? null, c.enabled ?? null]
  );
  return rows[0] || null;
}
export async function setApiAccessToken(id, tokenHash, tokenFin) {
  const { rows } = await pool.query(
    `UPDATE api_access SET token_hash = $2, token_fin = $3, updated_at = now()
     WHERE id = $1 RETURNING ${API_ACCESS_COLS}`,
    [id, tokenHash, tokenFin]
  );
  return rows[0] || null;
}
export async function deleteApiAccess(id) {
  const { rowCount } = await pool.query('DELETE FROM api_access WHERE id = $1', [id]);
  return rowCount > 0;
}
// Uso: consulta respondida (limited=false) o rechazada por exceder el límite (limited=true)
export async function recordApiAccessUse(id, ip, limited) {
  await pool.query(
    limited
      ? 'UPDATE api_access SET limitadas = limitadas + 1 WHERE id = $1'
      : 'UPDATE api_access SET consultas = consultas + 1, last_used_at = now(), last_ip = $2 WHERE id = $1',
    limited ? [id] : [id, ip ?? null]
  );
}

// ---------- api_access_log (registro de consultas de la API externa) ----------
export async function insertApiAccessLog(e) {
  await pool.query(
    `INSERT INTO api_access_log (access_id, usuario, ip, metodo, status, resultado, vehiculos, con_posicion, filtro, token_fin, user_agent, ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [e.accessId ?? null, e.usuario ?? null, e.ip ?? null, e.metodo ?? null, e.status, e.resultado,
      e.vehiculos ?? null, e.conPosicion ?? null, e.filtro ?? null, e.tokenFin ?? null, e.userAgent ?? null, e.ms ?? null]
  );
}
// accessId = null → intentos sin acceso identificado
export async function listApiAccessLog({ accessId = null, onlyErrors = false, sinceHours = null, limit = 100 } = {}) {
  const params = [];
  const where = [];
  if (accessId == null) where.push('access_id IS NULL');
  else { params.push(accessId); where.push(`access_id = $${params.length}`); }
  if (onlyErrors) where.push('status >= 400');
  if (sinceHours) { params.push(sinceHours); where.push(`ts > now() - ($${params.length} * interval '1 hour')`); }
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT id, ts, access_id, usuario, ip, metodo, status, resultado, vehiculos, con_posicion, filtro, token_fin, user_agent, ms
       FROM api_access_log WHERE ${where.join(' AND ')} ORDER BY ts DESC, id DESC LIMIT $${params.length}`,
    params
  );
  return rows;
}
// Por acceso (access_id NULL = sin identificar): respondidas, rechazadas y último rechazo
export async function apiAccessLogSummary(hours) {
  const { rows } = await pool.query(
    `SELECT access_id,
            count(*) FILTER (WHERE status < 400)::int  AS ok,
            count(*) FILTER (WHERE status >= 400)::int AS errores,
            max(ts) FILTER (WHERE status >= 400)       AS ultimo_error
       FROM api_access_log WHERE ts > now() - ($1 * interval '1 hour')
      GROUP BY access_id`,
    [hours]
  );
  return rows;
}
export async function pruneApiAccessLog(days) {
  const r = await pool.query(`DELETE FROM api_access_log WHERE ts < now() - ($1 * interval '1 day')`, [days]);
  return r.rowCount || 0;
}

// ---------- position_history ----------
// rows: puntos normalizados de track-analysis.js ({ t, lat, lng, speed, dir, ign, odo }).
// Inserta en lotes; los repetidos (misma PK vehicle_id+ts) se ignoran.
export async function insertPositions(vehicleId, rows) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const values = [];
    const params = [];
    chunk.forEach((r, j) => {
      const b = j * 8;
      values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`);
      params.push(String(vehicleId), new Date(r.t), r.lat, r.lng, r.speed ?? null, r.dir ?? null, r.ign ?? null, r.odo ?? null);
    });
    const res = await pool.query(
      `INSERT INTO position_history (vehicle_id, ts, lat, lng, speed, direction, ignition, odometer)
       VALUES ${values.join(',')} ON CONFLICT DO NOTHING`,
      params
    );
    inserted += res.rowCount || 0;
  }
  return inserted;
}
export async function getPositions(vehicleId, from, to) {
  const { rows } = await pool.query(
    `SELECT ts, lat, lng, speed, direction, ignition, odometer
       FROM position_history WHERE vehicle_id = $1 AND ts >= $2 AND ts <= $3 ORDER BY ts`,
    [String(vehicleId), from, to]
  );
  return rows.map((r) => ({
    t: r.ts.getTime(), lat: r.lat, lng: r.lng,
    speed: r.speed ?? 0, dir: r.direction ?? null, ign: r.ignition ?? null, odo: r.odometer ?? null,
  }));
}
// Primer/último ts guardado por vehículo (para saber desde cuándo hay cobertura local)
export async function getPositionCoverage(vehicleId) {
  const { rows } = await pool.query(
    'SELECT min(ts) AS first, max(ts) AS last, count(*)::int AS n FROM position_history WHERE vehicle_id = $1',
    [String(vehicleId)]
  );
  const r = rows[0] || {};
  return { first: r.first || null, last: r.last || null, n: r.n || 0 };
}
// ts recientes ya guardados (para no reinsertar lo mismo en cada refresh)
export async function loadRecentPositionTs(minutes) {
  const { rows } = await pool.query(
    `SELECT vehicle_id, ts FROM position_history WHERE ts > now() - make_interval(mins => $1)`,
    [minutes]
  );
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.vehicle_id)) map.set(r.vehicle_id, new Set());
    map.get(r.vehicle_id).add(r.ts.getTime());
  }
  return map;
}
export async function prunePositions(days) {
  const r = await pool.query(`DELETE FROM position_history WHERE ts < now() - ($1 * interval '1 day')`, [days]);
  return r.rowCount || 0;
}

// ---------- retención ----------
// ---------- métricas ----------
// Serie, totales y período anterior salen de send_stats_hourly (agregados). Los listados
// de fallos salen de send_errors_hourly (horas cerradas) más send_history solo para los
// bordes del rango (la primera hora parcial y lo que aún no se agrupó), acotado por el
// índice parcial de errores. Sin send_errors_hourly listo, todo sale de send_history.
const ERROR_DETAIL_SQL = `COALESCE(
  entry->>'error',
  entry->'response'->>'error',
  entry->'response'->>'message',
  CASE WHEN jsonb_typeof(entry->'response') = 'string' THEN entry->>'response' END,
  'HTTP ' || COALESCE(status::text, '0'))`;
// Mismo mensaje agrupado: los números largos como IMEI se reemplazan por # para que no se
// parta por vehículo
const ERROR_NORM_SQL = (col) => `left(regexp_replace(${col}, '\\d{5,}', '#', 'g'), 160)`;

// client: solo ese cliente (null = todos). errorsUntil: hasta dónde está agrupado
// send_errors_hourly (null = no está listo).
export async function getSendStats({ hours = 24, client = null, errorsUntil = null } = {}) {
  const bucket = hours <= 48 ? 'hour' : 'day';
  const aggFrom = `bucket >= date_trunc('hour', now() - make_interval(hours => $1))`;
  const rawRange = `ts >= now() - make_interval(hours => $1)`;
  // $1 = horas, $2 = cliente (o null = todos)
  const byC = `($2::text IS NULL OR client = $2)`;
  const p = [hours, client];
  const [series, byClient, vehicles, prev, topErrors, topErrorTypes, cov] = await Promise.all([
    pool.query(
      `SELECT date_trunc('${bucket}', bucket) AS bucket, client,
              sum(aceptados)::int AS aceptados, sum(rechazados)::int AS rechazados, sum(errores)::int AS errores
         FROM send_stats_hourly WHERE ${aggFrom} AND ${byC}
        GROUP BY 1, 2 ORDER BY 1`,
      p
    ),
    pool.query(
      `SELECT client, sum(total)::int AS total, sum(aceptados)::int AS aceptados,
              sum(rechazados)::int AS rechazados, sum(errores)::int AS errores
         FROM send_stats_hourly WHERE ${aggFrom} AND ${byC}
        GROUP BY client ORDER BY total DESC`,
      p
    ),
    pool.query(
      `SELECT client, count(DISTINCT vehicle_id)::int AS vehiculos
         FROM send_stats_vehicle_hourly WHERE ${aggFrom} AND ${byC}
        GROUP BY client`,
      p
    ),
    pool.query(
      `SELECT COALESCE(sum(total), 0)::int AS total, COALESCE(sum(aceptados), 0)::int AS aceptados
         FROM send_stats_hourly
        WHERE bucket >= date_trunc('hour', now() - make_interval(hours => $1::int * 2))
          AND bucket <  date_trunc('hour', now() - make_interval(hours => $1))
          AND ${byC}`,
      p
    ),
    errorsUntil ? topErrorsFromAgg(hours, client, errorsUntil) : pool.query(
      `SELECT vehicle_id, client,
              count(*)::int AS fallos,
              max(ts)       AS ultimo,
              (array_agg(${ERROR_DETAIL_SQL} ORDER BY ts DESC))[1] AS detalle,
              (array_agg(status ORDER BY ts DESC))[1] AS status
         FROM send_history
        WHERE ${rawRange} AND ok IS NOT TRUE AND vehicle_id IS NOT NULL AND ${byC}
        GROUP BY vehicle_id, client
        ORDER BY fallos DESC, ultimo DESC
        LIMIT 8`,
      p
    ),
    errorsUntil ? topErrorTypesFromAgg(hours, client, errorsUntil) : pool.query(
      `SELECT client, detalle, status,
              count(*)::int AS fallos,
              count(DISTINCT vehicle_id)::int AS vehiculos,
              max(ts) AS ultimo
         FROM (
           SELECT client, vehicle_id, ts, status, ${ERROR_NORM_SQL(ERROR_DETAIL_SQL)} AS detalle
             FROM send_history
            WHERE ${rawRange} AND ok IS NOT TRUE AND ${byC}
         ) s
        GROUP BY client, detalle, status
        ORDER BY fallos DESC, ultimo DESC
        LIMIT 10`,
      p
    ),
    getStatsCoverage(),
  ]);
  const vehiculosByClient = new Map(vehicles.rows.map((r) => [r.client, r.vehiculos]));
  return {
    bucket,
    series: series.rows.map((r) => ({ ...r, bucket: r.bucket.toISOString() })),
    byClient: byClient.rows.map((r) => ({ ...r, vehiculos: vehiculosByClient.get(r.client) || 0 })),
    topErrors: topErrors.rows.map((r) => ({ ...r, ultimo: r.ultimo.toISOString() })),
    topErrorTypes: topErrorTypes.rows.map((r) => ({ ...r, ultimo: r.ultimo.toISOString() })),
    prev: prev.rows[0] || { total: 0, aceptados: 0 },
    updatedAt: cov.updatedAt ? cov.updatedAt.toISOString() : null,
  };
}

// Errores del rango [now() - horas, now()] como filas agrupadas (cliente, vehículo, código,
// mensaje): horas cerradas ya agrupadas en [h0, $3) + send_history para la primera hora
// parcial [now() - horas, h0) y para lo que aún no se agrupó (desde $3).
// $1 = horas, $2 = cliente (o null), $3 = hasta dónde está agrupado.
const ERRORS_CTE = (() => {
  const h0 = `(date_trunc('hour', now() - make_interval(hours => $1)) + interval '1 hour')`;
  const byC = `($2::text IS NULL OR client = $2)`;
  return `WITH raw AS (
    SELECT client, vehicle_id, status, ts, ${ERROR_DETAIL_SQL} AS det
      FROM send_history
     WHERE ok IS NOT TRUE AND ts >= now() - make_interval(hours => $1) AND ts < ${h0} AND ${byC}
    UNION ALL
    SELECT client, vehicle_id, status, ts, ${ERROR_DETAIL_SQL} AS det
      FROM send_history
     WHERE ok IS NOT TRUE AND ts >= GREATEST($3::timestamptz, ${h0}) AND ${byC}
  ), err AS (
    SELECT client, vehicle_id, status, detalle, fallos, ultimo, ultimo_detalle
      FROM send_errors_hourly
     WHERE bucket >= ${h0} AND bucket < $3::timestamptz AND ${byC}
    UNION ALL
    SELECT client, vehicle_id, status, ${ERROR_NORM_SQL('det')}, count(*)::int, max(ts), (array_agg(det ORDER BY ts DESC))[1]
      FROM raw GROUP BY 1, 2, 3, 4
  )`;
})();
function topErrorsFromAgg(hours, client, errorsUntil) {
  return pool.query(
    `${ERRORS_CTE}
     SELECT vehicle_id, client,
            sum(fallos)::int AS fallos,
            max(ultimo)      AS ultimo,
            (array_agg(ultimo_detalle ORDER BY ultimo DESC))[1] AS detalle,
            (array_agg(status ORDER BY ultimo DESC))[1] AS status
       FROM err WHERE vehicle_id IS NOT NULL
      GROUP BY vehicle_id, client
      ORDER BY fallos DESC, ultimo DESC
      LIMIT 8`,
    [hours, client, errorsUntil]
  );
}
function topErrorTypesFromAgg(hours, client, errorsUntil) {
  return pool.query(
    `${ERRORS_CTE}
     SELECT client, detalle, status,
            sum(fallos)::int AS fallos,
            count(DISTINCT vehicle_id)::int AS vehiculos,
            max(ultimo) AS ultimo
       FROM err
      GROUP BY client, detalle, status
      ORDER BY fallos DESC, ultimo DESC
      LIMIT 10`,
    [hours, client, errorsUntil]
  );
}

export async function pruneHistory(days) {
  const r1 = await pool.query(`DELETE FROM send_history WHERE ts < now() - ($1 * interval '1 day')`, [days]);
  const r2 = await pool.query(`DELETE FROM activity_log WHERE ts < now() - ($1 * interval '1 day')`, [days]);
  await pool.query(`DELETE FROM send_stats_hourly WHERE bucket < now() - ($1 * interval '1 day')`, [days]);
  await pool.query(`DELETE FROM send_stats_vehicle_hourly WHERE bucket < now() - ($1 * interval '1 day')`, [days]);
  await pool.query(`DELETE FROM send_errors_hourly WHERE bucket < now() - ($1 * interval '1 day')`, [days]);
  return { removed: (r1.rowCount || 0) + (r2.rowCount || 0) };
}

export { pool };
