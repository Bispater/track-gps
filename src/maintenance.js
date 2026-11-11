// =============================================================
// maintenance.js · tareas de fondo sobre Postgres
// =============================================================
//   - retención: borra historial y posiciones más viejos que los días configurados
//   - agregados de métricas (send_stats_hourly): se preparan al arrancar y se refrescan cada minuto
//   - errores agrupados por hora (send_errors_hourly): se llenan al arrancar y se agrega cada
//     hora que se cierra
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

// Hasta dónde está agrupado send_errors_hourly (inicio de la primera hora sin agrupar).
// null = todavía no está listo: Métricas lee los errores de send_history como antes.
let errorsUntil = null;
let errorsRollupRunning = false;
export const getErrorsUntil = () => errorsUntil;
const HOUR = 3600e3;
const hourStart = (t) => new Date(Math.floor(t / HOUR) * HOUR);

// Agrupa las horas cerradas desde `from` hasta la hora en curso, de a un día por vez para
// no tener ocupada la base con una sola consulta larga.
async function rollErrors(from) {
  const to = hourStart(Date.now());
  for (let a = from.getTime(); a < to.getTime(); a += 24 * HOUR) {
    await db.rollupSendErrors(new Date(a), new Date(Math.min(a + 24 * HOUR, to.getTime())));
  }
  errorsUntil = to;
}
async function prepareErrorStats() {
  try {
    const t0 = Date.now();
    const last = await db.getErrorsCoverage();
    // Primera vez: todo el período de retención. Reinicios: desde la última hora agrupada.
    const from = last ? new Date(last) : hourStart(Date.now() - (RETENTION_DAYS * 24 + 24) * HOUR);
    await rollErrors(from);
    console.log(`[stats] errores agrupados listos (${Math.round((Date.now() - from.getTime()) / HOUR)} h en ${Math.round((Date.now() - t0) / 1000)} s)`);
  } catch (err) {
    console.error('[stats] error agrupando errores de métricas:', String(err));
  }
}
// Cada minuto: si se cerró una hora, se agrupa (rehaciendo también la anterior)
async function rollErrorsIfHourClosed() {
  if (!errorsUntil || errorsRollupRunning || hourStart(Date.now()) <= errorsUntil) return;
  errorsRollupRunning = true;
  try { await rollErrors(new Date(errorsUntil.getTime() - HOUR)); }
  catch (err) { console.warn('[stats] errores agrupados:', String(err)); }
  finally { errorsRollupRunning = false; }
}

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

  prepareStats().then(prepareErrorStats);
  setInterval(rollErrorsIfHourClosed, 60 * 1000);
  setInterval(async () => {
    if (!statsReady || statsRollupRunning) return;
    statsRollupRunning = true;
    try { await db.rollupSendStats({ sinceHours: 2 }); }
    catch (err) { console.warn('[stats] rollup:', String(err)); }
    finally { statsRollupRunning = false; }
  }, 60 * 1000);
}
