// =============================================================
// db.js · capa de persistencia Postgres
// =============================================================
// Reemplaza el storage en archivos planos (logs/*.jsonl, *-groups.json).
// Todo el estado del concentrador vive ahora en Postgres:
//   - group_config     → config de envío por cliente+grupo (intervalo, enabled, etc.)
//   - send_history     → historial de envíos por cliente (lo que iban a los *-history.jsonl)
//   - activity_log     → log general (lo que iba a activity.jsonl)
//   - blocked_vehicle  → vehículos bloqueados por cliente (ej: Wise estado 4)
//
// La cache de fm-track (objects/positions/groups) NO se persiste: vive en RAM
// porque es solo un espejo TTL de la API de fm-track.
import pg from 'pg';

const { Pool } = pg;

// pg lee DATABASE_URL automáticamente, o las vars PG* (PGHOST, PGUSER, …).
const pool = new Pool(
  process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}
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
    `INSERT INTO send_history (client, group_id, vehicle_id, ok, accepted, status, entry)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      client,
      entry?.groupId ?? null,
      entry?.vehicleId != null ? String(entry.vehicleId) : null,
      typeof entry?.ok === 'boolean' ? entry.ok : null,
      typeof entry?.accepted === 'boolean' ? entry.accepted : null,
      Number.isFinite(entry?.status) ? entry.status : null,
      entry ?? {},
    ]
  );
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

// ---------- retención ----------
export async function pruneHistory(days) {
  const r1 = await pool.query(`DELETE FROM send_history WHERE ts < now() - ($1 * interval '1 day')`, [days]);
  const r2 = await pool.query(`DELETE FROM activity_log WHERE ts < now() - ($1 * interval '1 day')`, [days]);
  return { removed: (r1.rowCount || 0) + (r2.rowCount || 0) };
}

export { pool };
