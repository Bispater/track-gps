// =============================================================
// maintenance.js · tareas de fondo sobre Postgres
// =============================================================
//   - retención: borra historial y posiciones más viejos que los días configurados
//   - agregados de métricas (send_stats_hourly): se preparan al arrancar y se refrescan cada minuto
import { RETENTION_DAYS, POSITION_RETENTION_DAYS } from './config.js';
import * as db from './db.js';

async function pruneAllHistories() {
  const { removed } = await db.pruneHistory(RETENTION_DAYS);
  if (removed > 0) {
    console.log(`[retention] purgados ${removed} registros más viejos que ${RETENTION_DAYS} días`);
  }
  const removedPos = await db.prunePositions(POSITION_RETENTION_DAYS);
  if (removedPos > 0) {
    console.log(`[retention] purgadas ${removedPos} posiciones más viejas que ${POSITION_RETENTION_DAYS} días`);
  }
}

let statsReady = false;
let statsRollupRunning = false;
export const isStatsReady = () => statsReady;

// Se preparan en segundo plano: en una base grande los índices y el primer rollup
// pueden tardar minutos, y los schedulers no deben esperar.
async function prepareStats() {
  try {
    const t0 = Date.now();
    await db.ensureIndexes();
    if (!(await db.getMeta('skipped_backfilled_at'))) {
      const n = await db.backfillSkipped(RETENTION_DAYS + 1);
      await db.setMeta('skipped_backfilled_at', new Date().toISOString());
      console.log(`[stats] backfill skipped: ${n} filas`);
    }
    const cov = await db.getStatsCoverage();
    // Primera vez: todo el período de retención. Reinicios: solo lo que pasó desde el último rollup.
    const sinceHours = cov.updatedAt
      ? Math.min(RETENTION_DAYS * 24 + 24, Math.ceil((Date.now() - cov.updatedAt.getTime()) / 3600e3) + 2)
      : RETENTION_DAYS * 24 + 24;
    await db.rollupSendStats({ sinceHours });
    statsReady = true;
    console.log(`[stats] agregados de métricas listos (${sinceHours} h recalculadas en ${Math.round((Date.now() - t0) / 1000)} s)`);
  } catch (err) {
    console.error('[stats] error preparando agregados de métricas:', String(err));
  }
}

export function startMaintenance() {
  // Purga a los 10 s del arranque y luego cada 24 h
  setTimeout(() => pruneAllHistories().catch(() => {}), 10 * 1000);
  setInterval(() => pruneAllHistories().catch(() => {}), 24 * 3600 * 1000);

  prepareStats();
  setInterval(async () => {
    if (!statsReady || statsRollupRunning) return;
    statsRollupRunning = true;
    try { await db.rollupSendStats({ sinceHours: 2 }); }
    catch (err) { console.warn('[stats] rollup:', String(err)); }
    finally { statsRollupRunning = false; }
  }, 60 * 1000);
}
