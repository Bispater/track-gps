// =============================================================
// Qanalytics (Q Integración) · un POST con el array de posiciones del grupo
// =============================================================
// Ambiente test/prod por grupo. Token: POST /Genera_Token con Basic Auth → Bearer de 3 h.
// Su API exige >=20 s entre llamadas a inserta_posiciones, vengan de donde vengan.
import { env } from '../config.js';
import { resolveVehicleIds } from '../fmtrack.js';
import { pick, readBody, clampInt, rawPlate, plainPlate } from '../util.js';
import { defineIntegration, eachVehicle } from './base.js';

const {
  QANALYTICS_API_URL = 'https://ww3.qanalytics.cl/Api_InsertaPosicion_General_test',
  QANALYTICS_USERNAME = '',
  QANALYTICS_PASSWORD = '',
  QANALYTICS_PROD_API_URL = '',
  QANALYTICS_PROD_USERNAME = '',
  QANALYTICS_PROD_PASSWORD = '',
  QANALYTICS_GROUPS = '',
} = env;

const prodConfigured = () => Boolean(QANALYTICS_PROD_API_URL && QANALYTICS_PROD_USERNAME && QANALYTICS_PROD_PASSWORD);
function envCfg(ambiente) {
  return ambiente === 'prod'
    ? { env: 'prod', base: QANALYTICS_PROD_API_URL.replace(/\/+$/, ''), user: QANALYTICS_PROD_USERNAME, pass: QANALYTICS_PROD_PASSWORD }
    : { env: 'test', base: QANALYTICS_API_URL.replace(/\/+$/, ''), user: QANALYTICS_USERNAME, pass: QANALYTICS_PASSWORD };
}

// Spec: fechas DATETIME en GMT 0, formato "yyyy-MM-ddTHH:mm:ss"
function toQanalyticsDatetime(ts) {
  const d = new Date(ts || Date.now());
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 19);
}

// ---------- token (cache por ambiente, margen de 10 min) ----------
const tokens = { test: { token: null, expiresAt: 0 }, prod: { token: null, expiresAt: 0 } };
const TOKEN_TTL_MS = (3 * 60 - 10) * 60 * 1000;
async function getToken(ambiente, force = false) {
  const cache = tokens[ambiente] || tokens.test;
  if (!force && cache.token && Date.now() < cache.expiresAt) return cache.token;
  const cfg = envCfg(ambiente);
  const basic = Buffer.from(`${cfg.user}:${cfg.pass}`).toString('base64');
  const r = await fetch(`${cfg.base}/Genera_Token/`, {
    method: 'POST',
    headers: { Accept: 'application/json', Authorization: `Basic ${basic}` },
  });
  const body = await readBody(r);
  if (!r.ok || !body?.accessToken) {
    const detail = typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body);
    throw new Error(`Genera_Token (${cfg.env}) HTTP ${r.status}: ${detail}`);
  }
  cache.token = body.accessToken;
  cache.expiresAt = Date.now() + TOKEN_TTL_MS;
  return cache.token;
}

// ---------- rate limit ----------
// Todas las llamadas de un ambiente van en fila, separadas por 21 s (20 s + 1 s de colchón);
// sin esto responden 400/429. Test y prod son cuentas independientes.
const MIN_GAP_MS = 21000;
const rate = { test: { lastCallAt: 0, queue: Promise.resolve() }, prod: { lastCallAt: 0, queue: Promise.resolve() } };
function withRateLimit(ambiente, fn) {
  const st = rate[ambiente] || rate.test;
  const run = st.queue.then(async () => {
    const wait = st.lastCallAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    st.lastCallAt = Date.now();
    return fn();
  });
  st.queue = run.then(() => {}, () => {});
  return run;
}

// ---------- payload ----------
function buildItem(obj, pos) {
  const placa = plainPlate(rawPlate(obj)); // PLACA sin guion según spec
  const lat = pick(pos, ['position.latitude']);
  const lon = pick(pos, ['position.longitude']);
  const hdopRaw = Number(pick(pos, ['device_inputs.hdop']));
  const item = {
    COD_VEH: String(pick(obj, ['imei', 'identifier']) || pick(obj, ['id']) || placa).slice(0, 50),
    PLACA: placa,
    LAT: lat != null ? Number(lat) : 0,
    LON: lon != null ? Number(lon) : 0,
    FH_SVR_GPS: toQanalyticsDatetime(Date.now()),
    FH_RPT_GPS: toQanalyticsDatetime(pick(pos, ['datetime'])),
    VEL: clampInt(pick(pos, ['position.speed']), 0, 1000, 0),
    SENT: clampInt(pick(pos, ['position.direction']), 0, 360, 0),
    CANT_SAT: clampInt(pick(pos, ['position.satellites_count']), 0, 100, 0),
    HDOP: Number.isFinite(hdopRaw) ? Math.min(Math.max(hdopRaw, 0), 100) : 0,
    IGN: pick(pos, ['ignition_status']) === 'ON' ? 1 : 0,
  };
  // Opcionales: solo si fm-track trae el dato (si no, Qanalytics usa su default)
  const alt = Number(pick(pos, ['position.altitude']));
  if (Number.isFinite(alt)) item.ALT = Math.min(Math.max(alt, -2000), 9999);
  const mv = Number(pick(pos, ['device_inputs.power_supply_voltage']));
  if (Number.isFinite(mv) && mv > 0) item.VOLT_VEH = Math.min(Math.round(mv / 10) / 100, 100);
  const odom = Number(pick(pos, ['calculated_inputs.mileage']));
  if (Number.isFinite(odom) && odom > 0) item.ODOM = Math.round(odom);
  for (let i = 0; i < 4; i++) {
    const t = Number(pick(pos, [`device_inputs.temperature_sensor_${i}`]));
    if (Number.isFinite(t) && t >= -100 && t <= 100) item[`TEMP${i + 1}`] = t;
  }
  return item;
}

async function postBatch(items, ambiente = 'test') {
  const cfg = envCfg(ambiente);
  const url = `${cfg.base}/inserta_posiciones/`;
  if (!cfg.base || !cfg.user || !cfg.pass) {
    const pref = ambiente === 'prod' ? 'QANALYTICS_PROD_*' : 'QANALYTICS_*';
    return { ok: false, status: 0, accepted: false, env: ambiente, response: { error: `Credenciales Qanalytics ${ambiente} no configuradas (${pref} en .env)` }, url };
  }
  try {
    const doPost = async (bearer) => fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${bearer}` },
      body: JSON.stringify(items),
    });
    let r = await withRateLimit(ambiente, async () => doPost(await getToken(ambiente)));
    if (r.status === 401) r = await withRateLimit(ambiente, async () => doPost(await getToken(ambiente, true)));
    const body = await readBody(r);
    const message = (body && typeof body === 'object' && body.message) ? String(body.message) : '';
    return { ok: r.ok, status: r.status, accepted: r.ok, message, env: ambiente, response: body, url };
  } catch (err) {
    return { ok: false, status: 0, accepted: false, env: ambiente, response: { error: String(err) }, url };
  }
}

async function send({ groupId, vehicleIds }) {
  const ids = await resolveVehicleIds(groupId, vehicleIds);
  if (!ids.length) return [];
  const items = [];
  const results = await eachVehicle(ids, { groupId, append: qanalytics.appendHistory }, ({ vehicleId, obj, pos }) => {
    items.push({ vehicleId, item: buildItem(obj, pos), raw: pos });
  });
  if (!items.length) return results;
  const ambiente = groupId && qanalytics.groups[groupId]?.env === 'prod' ? 'prod' : 'test';
  const batch = await postBatch(items.map((x) => x.item), ambiente);
  for (const it of items) {
    const entry = {
      vehicleId: it.vehicleId,
      ok: batch.ok, status: batch.status, accepted: batch.accepted,
      message: batch.message, response: batch.response, url: batch.url,
      payload: it.item, raw: it.raw, groupId,
    };
    await qanalytics.appendHistory(entry);
    results.push(entry);
  }
  return results;
}

const qanalytics = defineIntegration({
  key: 'qanalytics',
  label: 'Qanalytics',
  groups: QANALYTICS_GROUPS,
  // Cada patente reporta máx cada 1 min con motor encendido; piso de 20 s entre llamadas
  intervalSec: 60,
  minIntervalSec: 20,
  tickMs: 5000,
  groupDefaults: () => ({ env: 'test' }),
  // Misma forma que Falabella para que el frontend muestre el par Test/Prod con switch por grupo
  config: () => ({
    testUrl: QANALYTICS_API_URL,
    prodUrl: QANALYTICS_PROD_API_URL || null,
    apikeyTestConfigured: Boolean(QANALYTICS_USERNAME && QANALYTICS_PASSWORD),
    apikeyProdConfigured: prodConfigured(),
    username: QANALYTICS_USERNAME || null,
    prodUsername: QANALYTICS_PROD_USERNAME || null,
  }),
  updateGroup(body, next) {
    if (body.env == null) return;
    const nextEnv = body.env === 'prod' ? 'prod' : 'test';
    if (nextEnv === 'prod' && !prodConfigured()) {
      return 'Credenciales de producción no configuradas (QANALYTICS_PROD_* en .env)';
    }
    next.env = nextEnv;
  },
  preview: (obj, pos) => [buildItem(obj, pos)],
  send,
  warnings: () => (QANALYTICS_USERNAME && QANALYTICS_PASSWORD ? [] : ['Credenciales Qanalytics no configuradas (usuario + contraseña Basic Auth)']),
});

export default qanalytics;
