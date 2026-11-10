// =============================================================
// Drivin · un POST con todas las posiciones del grupo
// =============================================================
// Payload con root "positions", "lng" en minúscula, timestamp en milisegundos y speed en m/s.
// No devuelve resultado por posición: el resultado del lote se aplica a todas.
import { env } from '../config.js';
import { resolveVehicleIds } from '../fmtrack.js';
import { pick, readBody, round, rawPlate } from '../util.js';
import { defineIntegration, eachVehicle } from './base.js';

const {
  DRIVIN_API_URL = 'https://external.driv.in/api/external/v2/positions',
  DRIVIN_API_KEY = '',
  DRIVIN_GROUPS = '',
} = env;

function buildItem(obj, pos) {
  // device_number y vehicle_code = PATENTE SIN ESPACIOS (ej: HCKP21), según correo del cliente
  const plate = String(rawPlate(obj) || '').replace(/\s+/g, '').toUpperCase().slice(0, 255);
  const lat = Number(pick(pos, ['position.latitude']));
  const lng = Number(pick(pos, ['position.longitude']));
  const dtRaw = pick(pos, ['datetime']);
  const tsMs = dtRaw ? new Date(dtRaw).getTime() : Date.now();
  const speedKmh = Number(pick(pos, ['position.speed']) ?? 0);
  const heading = Number(pick(pos, ['position.direction']) ?? 0);

  const item = {
    device_number: plate,
    lat: Number.isFinite(lat) ? lat : 0,
    lng: Number.isFinite(lng) ? lng : 0,
    // MILISEGUNDOS (ej. de la doc: 1519135237474)
    timestamp: Number.isFinite(tsMs) ? tsMs : Date.now(),
  };
  if (plate) item.vehicle_code = plate;
  if (Number.isFinite(speedKmh)) item.speed = round(speedKmh / 3.6, 2); // km/h → m/s
  if (Number.isFinite(heading)) item.heading = heading;

  // Temperaturas 1-indexed (temp1..temp4) según el ejemplo de la doc
  const temperature = {};
  for (let i = 0; i <= 3; i++) {
    const t = pick(pos, [`device_inputs.temperature_sensor_${i}`]);
    if (t != null && Number.isFinite(Number(t))) temperature[`temp${i + 1}`] = Number(t);
  }
  if (Object.keys(temperature).length) item.temperature = temperature;
  return item;
}

async function postBatch(payload) {
  if (!DRIVIN_API_KEY) {
    return { ok: false, status: 0, accepted: false, response: { error: 'DRIVIN_API_KEY no configurado en .env' }, url: DRIVIN_API_URL };
  }
  try {
    const r = await fetch(DRIVIN_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-API-Key': DRIVIN_API_KEY },
      body: JSON.stringify(payload),
    });
    const body = await readBody(r);
    // 201 + { success: true, status: "OK" }
    const accepted = r.status === 201 && body && typeof body === 'object' && body.success === true;
    return { ok: r.ok, status: r.status, accepted, response: body, url: DRIVIN_API_URL };
  } catch (err) {
    return { ok: false, status: 0, accepted: false, response: { error: String(err) }, url: DRIVIN_API_URL };
  }
}

async function send({ groupId, vehicleIds }) {
  const ids = await resolveVehicleIds(groupId, vehicleIds);
  if (!ids.length) return [];
  const items = [];
  const results = await eachVehicle(ids, { groupId, append: drivin.appendHistory }, ({ vehicleId, obj, pos }) => {
    items.push({ vehicleId, payloadItem: buildItem(obj, pos), raw: pos });
  });
  if (!items.length) return results;

  const batch = await postBatch({ positions: items.map((x) => x.payloadItem) });
  for (const it of items) {
    const entry = {
      vehicleId: it.vehicleId,
      ok: batch.ok,
      status: batch.status,
      accepted: batch.accepted,
      response: batch.response,
      payload: { positions: [it.payloadItem] },
      raw: it.raw,
      url: batch.url,
      groupId,
      batchSize: items.length,
    };
    await drivin.appendHistory(entry);
    results.push(entry);
  }
  return results;
}

const drivin = defineIntegration({
  key: 'drivin',
  label: 'Drivin',
  groups: DRIVIN_GROUPS,
  intervalSec: 30,
  minIntervalSec: 5,
  config: () => ({ url: DRIVIN_API_URL, keyConfigured: Boolean(DRIVIN_API_KEY) }),
  preview: (obj, pos) => ({ positions: [buildItem(obj, pos)] }),
  send,
  warnings: () => (DRIVIN_API_KEY ? [] : ['DRIVIN_API_KEY no configurado']),
});

export default drivin;
