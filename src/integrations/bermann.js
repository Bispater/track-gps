// =============================================================
// Bermann · un POST por vehículo
// =============================================================
// Auth: POST /auth con usuario/clave → token Bearer de 1 h (se cachea 55 min). Si el envío
// responde 401/403 se renueva el token y se reintenta una vez.
import { env } from '../config.js';
import { resolveVehicleIds } from '../fmtrack.js';
import { pick, readBody, clampInt, round, rawPlate, plainPlate, formatUtc } from '../util.js';
import { defineIntegration, eachVehicle } from './base.js';

const {
  BERMANN_API_BASE = 'https://concentrador.bermann.cl/integracion_bermann/api',
  BERMANN_ID_CLIENTE_EXTERNO = '',
  BERMANN_USERNAME = '',
  BERMANN_PASSWORD = '',
  BERMANN_GROUPS = '',
} = env;

const API = BERMANN_API_BASE.replace(/\/$/, '');
const hasCredentials = () => Boolean(BERMANN_ID_CLIENTE_EXTERNO && BERMANN_USERNAME && BERMANN_PASSWORD);

// ---------- token ----------
let token = null;
let tokenExpiresAt = 0;
let authInFlight = null; // evita varios /auth simultáneos

async function getToken({ forceRefresh = false } = {}) {
  if (!forceRefresh && token && Date.now() < tokenExpiresAt) return token;
  if (authInFlight) return authInFlight;
  authInFlight = (async () => {
    if (!hasCredentials()) {
      throw new Error('Credenciales Bermann no configuradas (.env: BERMANN_ID_CLIENTE_EXTERNO, BERMANN_USERNAME, BERMANN_PASSWORD)');
    }
    const r = await fetch(API + '/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        id_cliente_externo: Number(BERMANN_ID_CLIENTE_EXTERNO),
        nombre_usuario: BERMANN_USERNAME,
        password_usuario: BERMANN_PASSWORD,
      }),
    });
    const body = await readBody(r);
    if (!r.ok || !body || !body.access_token) {
      throw new Error(`Auth Bermann falló: HTTP ${r.status} · ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    }
    token = body.access_token;
    tokenExpiresAt = Date.now() + 55 * 60 * 1000; // 55 min de margen sobre la hora real
    return token;
  })().finally(() => { authInFlight = null; });
  return authInFlight;
}

// ---------- payload ----------
// "yyyy-MM-dd HH:mm:ss" UTC. Regla de negocio: no enviar fechas adelantadas a la actual.
function toBermannDatetime(ts) {
  let d = new Date(ts || Date.now());
  if (isNaN(d.getTime())) d = new Date();
  const now = new Date();
  if (d.getTime() > now.getTime()) d = now;
  return formatUtc(d);
}

function buildPayload(obj, pos) {
  const lat = pick(pos, ['position.latitude']);
  const lon = pick(pos, ['position.longitude']);
  const altitude = Number(pick(pos, ['position.altitude']) ?? 0);
  const hdopRaw = pick(pos, ['device_inputs.hdop']);
  const voltage = pick(pos, ['device_inputs.power_supply_voltage']);
  const payload = {
    fecha: toBermannDatetime(pick(pos, ['datetime'])),
    imei: String(pick(obj, ['imei', 'identifier']) || ''),
    // Bermann registra las patentes SIN guión (ej: "PJKY92"), a diferencia de Wise
    patente: plainPlate(rawPlate(obj)),
    latitud: String(lat != null ? Number(lat) : ''),
    longitud: String(lon != null ? Number(lon) : ''),
    orientacion: clampInt(pick(pos, ['position.direction']), 0, 360, 0),
    velocidad: round(Number(pick(pos, ['position.speed']) ?? 0), 2),
    id_cliente_externo: Number(BERMANN_ID_CLIENTE_EXTERNO) || 0,
    altitud: Number.isFinite(altitude) ? Math.round(altitude) : 0,
    estado_motor: pick(pos, ['ignition_status']) === 'ON' ? 1 : 0,
    hdop: hdopRaw != null && Number.isFinite(Number(hdopRaw)) ? Number(hdopRaw) : 0,
    num_sat: clampInt(pick(pos, ['position.satellites_count']), 0, 100, 0),
  };
  // power_supply_voltage de fm-track viene en mV → V
  if (voltage != null && Number.isFinite(Number(voltage))) payload.voltaje_externo = round(Number(voltage) / 1000, 2);
  return payload;
}

async function sendOne(payload) {
  if (!hasCredentials()) {
    return { ok: false, status: 0, accepted: false, response: { error: 'Credenciales Bermann no configuradas en .env' }, url: BERMANN_API_BASE };
  }
  const url = API + '/data/insert';
  let t;
  try { t = await getToken(); }
  catch (err) { return { ok: false, status: 0, accepted: false, response: { error: String(err) }, url }; }

  const postOnce = async (bearer) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${bearer}` },
      body: JSON.stringify(payload),
    });
    return { r, body: await readBody(r) };
  };

  try {
    let { r, body } = await postOnce(t);
    // Token vencido (401/403): renovar y reintentar una vez
    if (r.status === 401 || r.status === 403) {
      token = null; tokenExpiresAt = 0;
      try { t = await getToken({ forceRefresh: true }); }
      catch (err) { return { ok: false, status: r.status, accepted: false, response: { error: 'auth refresh fallo: ' + err.message }, url }; }
      ({ r, body } = await postOnce(t));
    }
    return { ok: r.ok, status: r.status, accepted: r.ok, response: body, url };
  } catch (err) {
    return { ok: false, status: 0, accepted: false, response: { error: String(err) }, url };
  }
}

async function send({ groupId, vehicleIds }) {
  const ids = await resolveVehicleIds(groupId, vehicleIds);
  if (!ids.length) return [];
  return eachVehicle(ids, { groupId, append: bermann.appendHistory }, async ({ vehicleId, obj, pos }) => {
    const payload = buildPayload(obj, pos);
    return { vehicleId, ...(await sendOne(payload)), payload, raw: pos, groupId };
  });
}

const bermann = defineIntegration({
  key: 'bermann',
  label: 'Bermann',
  groups: BERMANN_GROUPS,
  intervalSec: 30,
  minIntervalSec: 5,
  config: () => ({
    url: BERMANN_API_BASE,
    credentialsConfigured: hasCredentials(),
    idClienteExterno: BERMANN_ID_CLIENTE_EXTERNO || null,
    tokenCached: Boolean(token && Date.now() < tokenExpiresAt),
    tokenExpiresAt: token ? new Date(tokenExpiresAt).toISOString() : null,
  }),
  preview: (obj, pos) => buildPayload(obj, pos),
  send,
  warnings: () => (hasCredentials() ? [] : ['Credenciales Bermann no configuradas']),
});

export default bermann;
