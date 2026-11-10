// =============================================================
// DS · un POST por vehículo (un objeto, no array)
// =============================================================
// Sin token: identifica al transportista con DS_EMPRESA + DS_RUT. Fecha en hora local Chile.
// Mínimo 60 s entre envíos según su doc.
import { env } from '../config.js';
import { resolveVehicleIds } from '../fmtrack.js';
import { pick, readBody, clampInt, rawPlate, plainPlate, formatLocal } from '../util.js';
import { defineIntegration, eachVehicle } from './base.js';

const {
  DS_API_URL = 'http://18.232.149.50/api/v1/postDataGPS',
  DS_EMPRESA = '',
  DS_RUT = '',
  DS_GROUPS = '',
  DS_TIMEZONE = 'America/Santiago',
} = env;

// RUT empresa transportista SIN puntos ni guion
const rutLimpio = () => String(DS_RUT || '').replace(/[.\-\s]/g, '');

// fechahora en hora local, formato "yyyy-MM-dd HH:mm:ss" (sin offset)
function toDsDatetime(ts) {
  const d = new Date(ts || Date.now());
  return isNaN(d.getTime()) ? '' : formatLocal(d, DS_TIMEZONE);
}

function buildPayload(obj, pos) {
  const lat = pick(pos, ['position.latitude']);
  const lon = pick(pos, ['position.longitude']);
  return {
    empresa: String(DS_EMPRESA || ''),
    rut: rutLimpio(),
    fechahora: toDsDatetime(pick(pos, ['datetime'])),
    idgps: String(pick(obj, ['imei', 'identifier']) || '').slice(0, 15),
    patente: plainPlate(rawPlate(obj)), // la doc dice "sin guion"
    latitud: String(lat != null ? Number(lat) : ''),
    longitud: String(lon != null ? Number(lon) : ''),
    sentido: clampInt(pick(pos, ['position.direction']), 0, 360, 0),
    velocidad: clampInt(pick(pos, ['position.speed']), 0, 1000, 0),
    motor: pick(pos, ['ignition_status']) === 'ON' ? 1 : 0,
  };
}

async function sendOne(payload) {
  if (!DS_EMPRESA || !DS_RUT) {
    return { ok: false, status: 0, accepted: false, response: { error: 'DS_EMPRESA y DS_RUT no configurados en .env' }, url: DS_API_URL };
  }
  try {
    const r = await fetch(DS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await readBody(r);
    // DS responde con dos formatos según versión de su API:
    //   doc original:  { estado: "OK"|"Error", mensaje: "..." }
    //   API actual:    { error: false|true, message: "Data actualizada."|"Data guardada." } (HTTP 201)
    const isObj = body && typeof body === 'object';
    const okEstado = isObj && typeof body.estado === 'string' && body.estado.toUpperCase() === 'OK';
    const okErrorFlag = isObj && body.error === false;
    const accepted = r.ok && (okEstado || okErrorFlag);
    const message = isObj ? String(body.mensaje || body.message || '') : '';
    return { ok: r.ok, status: r.status, accepted, message, response: body, url: DS_API_URL };
  } catch (err) {
    return { ok: false, status: 0, accepted: false, response: { error: String(err) }, url: DS_API_URL };
  }
}

async function send({ groupId, vehicleIds }) {
  const ids = await resolveVehicleIds(groupId, vehicleIds);
  if (!ids.length) return [];
  return eachVehicle(ids, { groupId, append: ds.appendHistory }, async ({ vehicleId, obj, pos }) => {
    const payload = buildPayload(obj, pos);
    return { vehicleId, ...(await sendOne(payload)), payload, raw: pos, groupId };
  });
}

const ds = defineIntegration({
  key: 'ds',
  label: 'DS',
  groups: DS_GROUPS,
  intervalSec: 60,
  minIntervalSec: 60,
  tickMs: 5000,
  config: () => ({
    url: DS_API_URL,
    credentialsConfigured: Boolean(DS_EMPRESA && DS_RUT),
    empresa: DS_EMPRESA || null,
    rut: DS_RUT ? rutLimpio() : null,
  }),
  preview: (obj, pos) => buildPayload(obj, pos),
  send,
  warnings: () => (DS_EMPRESA && DS_RUT ? [] : ['Credenciales DS no configuradas (empresa + rut transportista)']),
});

export default ds;
