// =============================================================
// track-service · concentrador GPS
// =============================================================
// Lee las posiciones de fm-track y las reenvía a cada destino configurado.
//   src/config.js          variables de entorno generales
//   src/fmtrack.js         cliente fm-track + caches de vehículos, posiciones y grupos
//   src/auth.js            login por cookie
//   src/routes.js          rutas generales (snapshot, grupos, proxy, métricas)
//   src/integrations/      un archivo por destino + base.js con lo común (rutas, scheduler)
//   src/track-history.js   historial de recorrido del mapa
//   src/maintenance.js     retención y agregados de métricas
//   src/db.js              Postgres
import { PORT, FM_TRACK_API_KEY, FM_TRACK_API_KEYS } from './src/config.js';
import express from 'express';
import * as db from './src/db.js';
import { registerAuth, logAuthStatus } from './src/auth.js';
import { callFmTrack, initPositionIndex, resolveApiKey } from './src/fmtrack.js';
import { startMaintenance } from './src/maintenance.js';
import { registerCoreRoutes } from './src/routes.js';
import { registerTrackRoutes } from './src/track-history.js';
import { integrations } from './src/integrations/index.js';
import { toArray } from './src/util.js';

// Postgres primero: espera a que esté listo y crea el schema
await db.initDb();
startMaintenance();
await initPositionIndex();
for (const it of integrations) await it.init();

const app = express();
app.use(express.json({ limit: '5mb' }));

registerAuth(app); // rutas abiertas + middleware de sesión: todo lo de abajo exige login
registerCoreRoutes(app);
for (const it of integrations) {
  it.registerRoutes(app);
  it.startScheduler();
}
registerTrackRoutes(app, { callFmTrack, toArray, db, resolveApiKey });

app.listen(PORT, () => {
  console.log(`track-service · http://localhost:${PORT}`);
  if (!FM_TRACK_API_KEY) console.warn('  ⚠  FM_TRACK_API_KEY no configurada');
  console.log(`  fm-track · ${FM_TRACK_API_KEYS.length} tenant(s) configurado(s)`);
  for (const it of integrations) for (const w of it.warnings()) console.warn(`  ⚠  ${w}`);
  logAuthStatus();
  for (const it of integrations) console.log(`  scheduler ${it.label} · ${it.activeSummary()} grupos activos`);
});
