// =============================================================
// CVX-R (StartSee) · recepción GPS · un POST con los eventos nuevos del grupo
// =============================================================
// Doc: https://startsee.cvx-r.cl/api/v1/docs/ — POST /api/v1/gps, Bearer = API key de CVX-R.
// Reglas de la doc:
//   - array de EventoGPS ordenado del más antiguo al más nuevo, máx 300 por request
//   - con contacto encendido, un evento cada 1 min como máximo; apagado, cada 10 min
//   - si el contacto no está conectado, informar contacto encendido en cada evento
// Por eso no se manda solo la última posición: se mandan todos los puntos que el equipo
// registró desde el último evento entregado (hasta CVXR_BACKFILL_MAX_MIN hacia atrás), así un
// camión que estuvo sin cobertura no deja huecos. La primera vez se manda solo la última.
//
// Respuesta: un resultado por evento → OK | WARN (duplicado: ya lo tienen) | ERROR.
// Errores de datos (4xx) no se reintentan: se registran y se avanza. Fallas de red, 5xx,
// 401 o 429 sí: el próximo ciclo vuelve a mandar desde el último evento entregado.
import crypto from 'node:crypto';
import * as db from '../db.js';
import { env } from '../config.js';
import { resolveVehicleIds, callFmTrack, resolveApiKey } from '../fmtrack.js';
import { pick, readBody, clampInt, round, rawPlate, plainPlate, toArray } from '../util.js';
import { defineIntegration, eachVehicle } from './base.js';

const {
  CVXR_API_URL = 'https://startsee.cvx-r.cl/api/v1/gps',
  CVXR_GROUPS = '',
  // Empresa contratista/transportista dueña de los vehículos (no viene en fm-track).
  // Si están vacíos, los eventos van sin esos campos.
  CVXR_CONTRATISTA = '',
  CVXR_RUT_CONTRATISTA = '',
  // Código MCC-MNC de las SIM de los equipos (ej. 73001 Entel, 73002 Movistar). Opcional.
  CVXR_CODIGO_OPERADOR_GSM = '',
  CVXR_BACKFILL_MAX_MIN = '120',
} = env;
const TOKEN = (env.CVXR_API_TOKEN || '').trim();
const RUT_CONTRATISTA = String(CVXR_RUT_CONTRATISTA).replace(/[^0-9kK]/g, '').toUpperCase();

const MAX_PER_REQUEST = 300;
const BACKFILL_MAX_MS = Math.max(1, Number(CVXR_BACKFILL_MAX_MIN) || 120) * 60 * 1000;
// El GET de diagnóstico de esta API llegó a quedarse colgado más de 60 s: sin tope, un
// envío colgado dejaría al scheduler esperando para siempre.
const TIMEOUT_MS = 30000;
// Respuestas que no se arreglan reenviando lo mismo (datos rechazados)
const isDefinitive = (status) => (status >= 200 && status < 300) ||
  (status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status));

// ---------- estado por vehículo ----------
// { lastSent: datetime del último evento entregado, ign: contacto en ese evento,
//   tripStartKm: odómetro al encender (para distancia_recorrida_viaje) }
// Se guarda en app_meta para sobrevivir a reinicios.
const states = new Map();
async function getState(vehicleId) {
  const id = String(vehicleId);
  if (!states.has(id)) {
    let s = null;
    try { s = JSON.parse((await db.getMeta(`cvxr_state:${id}`)) || 'null'); } catch { s = null; }
    states.set(id, s || {});
  }
  return states.get(id);
}
async function saveState(vehicleId, s) {
  states.set(String(vehicleId), s);
  await db.setMeta(`cvxr_state:${vehicleId}`, JSON.stringify(s));
}

// ---------- puntos a enviar ----------
const ts = (p) => new Date(p?.datetime).getTime();

// Puntos del vehículo posteriores a lastSent, del más antiguo al más nuevo
async function pointsSince(vehicleId, lastSent, latest) {
  const after = new Date(lastSent).getTime();
  const qs = new URLSearchParams({
    fromDatetime: new Date(Math.max(after, Date.now() - BACKFILL_MAX_MS)).toISOString(),
    toDatetime: new Date().toISOString(),
    limit: '1000',
  });
  const r = await callFmTrack(`/objects/${encodeURIComponent(vehicleId)}/coordinates?${qs}`, await resolveApiKey(vehicleId));
  if (!r.ok) throw new Error(`fm-track coordinates → HTTP ${r.status}`);
  const byTs = new Map();
  for (const p of [...toArray(r.data?.items ?? r.data), latest]) {
    if (p && ts(p) > after) byTs.set(ts(p), p);
  }
  return [...byTs.values()].sort((a, b) => ts(a) - ts(b));
}

// ---------- payload ----------
const isoSec = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
const finite = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

// Identificador único y estable del evento (≤ 40 chars): reenviar el mismo punto da WARN
// "duplicado" en vez de duplicarlo.
function eventId(imei, vehicleId, datetime) {
  const sec = Math.floor(new Date(datetime).getTime() / 1000);
  return imei ? `${imei}-${sec}` : crypto.createHash('sha1').update(`${vehicleId}|${sec}`).digest('hex');
}

// Arma los eventos en orden llevando el estado del vehículo (contacto previo → tipo_evento,
// odómetro al encender → distancia del viaje). Cada evento lleva el estado resultante en
// `state`, que solo se guarda si CVX-R lo recibe.
function buildEvents(obj, vehicleId, points, startState) {
  const imeiRaw = String(pick(obj, ['imei']) || '');
  const imei = /^\d{15}$/.test(imeiRaw) ? imeiRaw : null;
  const patente = plainPlate(rawPlate(obj)).slice(0, 10);
  let { ign = null, tripStartKm = null } = startState;
  const out = [];
  for (const pos of points) {
    const lat = finite(pick(pos, ['position.latitude']));
    const lng = finite(pick(pos, ['position.longitude']));
    if (lat == null || lng == null) continue;
    const datetime = pick(pos, ['datetime']);
    const on = pick(pos, ['ignition_status']) !== 'OFF'; // desconocido → encendido (doc)
    const km = finite(pick(pos, ['calculated_inputs.mileage']));
    const changed = ign != null && ign !== on;
    if (!on) tripStartKm = null;
    else if (ign === false || tripStartKm == null) tripStartKm = km;
    ign = on;

    const hdop = finite(pick(pos, ['device_inputs.hdop']));
    const mv = finite(pick(pos, ['device_inputs.power_supply_voltage']));
    const ev = {
      id_evento: eventId(imei, vehicleId, datetime),
      patente,
      numero_interno: 0,
      ...(CVXR_CONTRATISTA ? { contratista: CVXR_CONTRATISTA.slice(0, 100) } : {}),
      ...(RUT_CONTRATISTA ? { rut_contratista: RUT_CONTRATISTA } : {}),
      fecha_hora_evento: isoSec(datetime),
      // fm-track no informa cuándo recibió el punto: se usa la hora del evento
      fecha_hora_recepcion: isoSec(datetime),
      latitud: lat,
      longitud: lng,
      direccion: clampInt(pick(pos, ['position.direction']), 0, 360, 0),
      velocidad: clampInt(pick(pos, ['position.speed']), 0, 999, 0),
      velocidad_maxima: 0, // doc: 0 si no está disponible
      altitud: clampInt(pick(pos, ['position.altitude']), -1000, 10000, 0),
      satelites: clampInt(pick(pos, ['position.satellites_count']), 0, 100, 0),
      ...(hdop != null ? { hdop } : {}),
      contacto: on,
      tipo_evento: changed ? 1 : 0, // 0 = por intervalo, 1 = ignición on/off
      ...(CVXR_CODIGO_OPERADOR_GSM ? { codigo_operador_gsm: String(CVXR_CODIGO_OPERADOR_GSM) } : {}),
      ...(imei ? { imei } : {}),
      distancia_recorrida_viaje: on && km != null && tripStartKm != null ? round(Math.max(0, km - tripStartKm), 1) : 0,
      ...(km != null ? { distancia_recorrida_total: round(km, 1) } : {}),
      ...(mv != null && mv > 0 ? { voltaje_bateria_vehiculo: round(mv / 1000, 2) } : {}), // mV → V
      green_driving: 0,
      green_driving_valor: 0,
      tipo_dato_opcional: 0,
      dato_opcional: {},
    };
    out.push({ event: ev, state: { lastSent: datetime, ign, tripStartKm } });
  }
  return out;
}

// ---------- envío ----------
// { evento, resultado, errores: { campo: [mensajes] } } → Map id_evento → resultado
function parseResults(body) {
  const list = Array.isArray(body) ? body : (body && typeof body === 'object' && body.evento != null ? [body] : []);
  const map = new Map();
  for (const r of list) {
    if (r?.evento != null) map.set(String(r.evento), { evento: String(r.evento), resultado: String(r.resultado || '').toUpperCase(), errores: r.errores || {} });
  }
  return map;
}
const erroresText = (errores) => Object.entries(errores || {})
  .map(([campo, msgs]) => `${campo}: ${[].concat(msgs).join(', ')}`).join(' · ');

async function postEvents(events) {
  if (!TOKEN) return { ok: false, status: 0, response: { error: 'CVXR_API_TOKEN no configurado en .env' }, results: new Map(), url: CVXR_API_URL };
  try {
    const r = await fetch(CVXR_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(events),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await readBody(r);
    return { ok: r.ok, status: r.status, response: body, results: parseResults(body), url: CVXR_API_URL };
  } catch (err) {
    const error = err?.name === 'TimeoutError' ? `sin respuesta de CVX-R en ${TIMEOUT_MS / 1000} s` : String(err);
    return { ok: false, status: 0, response: { error }, results: new Map(), url: CVXR_API_URL };
  }
}

async function send({ groupId, vehicleIds }) {
  const ids = await resolveVehicleIds(groupId, vehicleIds);
  if (!ids.length) return [];

  const pending = []; // { vehicleId, built: [{ event, state }], raw }
  const results = await eachVehicle(ids, { groupId, append: cvxr.appendHistory }, async ({ vehicleId, obj, pos }) => {
    const state = await getState(vehicleId);
    if (state.lastSent && ts(pos) <= new Date(state.lastSent).getTime()) {
      return { vehicleId, ok: true, accepted: false, skipped: true, message: 'sin cambios (mismo datetime)', groupId, raw: pos };
    }
    const points = state.lastSent ? await pointsSince(vehicleId, state.lastSent, pos) : [pos];
    const built = buildEvents(obj, vehicleId, points, state);
    if (!built.length) return { vehicleId, ok: false, accepted: false, error: 'posición sin coordenadas', groupId, raw: pos };
    pending.push({ vehicleId, built, raw: pos });
  });
  if (!pending.length) return results;

  // Todos los eventos del grupo, del más antiguo al más nuevo, en requests de hasta 300
  const all = pending.flatMap((p) => p.built.map((b) => b.event))
    .sort((a, b) => new Date(a.fecha_hora_evento) - new Date(b.fecha_hora_evento));
  const outcome = new Map(); // id_evento → { resultado, errores, status, ok, url }
  for (let i = 0; i < all.length; i += MAX_PER_REQUEST) {
    const chunk = all.slice(i, i + MAX_PER_REQUEST);
    const r = await postEvents(chunk);
    // Eventos sin resultado propio en la respuesta: toman el del request completo
    // (en un rechazo, el único error que venga se aplica a todos)
    const general = r.ok ? 'OK' : 'ERROR';
    const generalErrores = r.ok ? {}
      : r.results.size === 1 ? [...r.results.values()][0].errores
      : { respuesta: [typeof r.response === 'string' ? r.response.slice(0, 200) : (r.response?.error || r.response?.message || `HTTP ${r.status}`)] };
    for (const ev of chunk) {
      const own = r.results.get(ev.id_evento);
      outcome.set(ev.id_evento, {
        resultado: own?.resultado || general,
        errores: own?.errores || generalErrores,
        definitive: isDefinitive(r.status),
        ok: r.ok, status: r.status,
        general: own ? undefined : r.response,
      });
    }
  }

  for (const p of pending) {
    const outs = p.built.map((b) => outcome.get(b.event.id_evento));
    const count = { OK: 0, WARN: 0, ERROR: 0 };
    for (const o of outs) count[o.resultado in count ? o.resultado : 'ERROR']++;
    const okHttp = outs.every((o) => o.ok);
    const accepted = okHttp && count.ERROR === 0;
    const errores = [...new Set(outs.filter((o) => o.resultado === 'ERROR').map((o) => erroresText(o.errores)).filter(Boolean))].join(' | ');
    const resumen = [`${outs.length} evento${outs.length === 1 ? '' : 's'}`,
      count.OK && `${count.OK} OK`, count.WARN && `${count.WARN} duplicado${count.WARN === 1 ? '' : 's'}`,
      count.ERROR && `${count.ERROR} con error`].filter(Boolean).join(' · ');

    // Avanzar hasta el último evento con respuesta definitiva, sin saltarse ninguno
    let reached = null;
    for (let i = 0; i < outs.length && outs[i].definitive; i++) reached = p.built[i].state;
    if (reached) await saveState(p.vehicleId, reached);

    const failed = outs.find((o) => !o.ok);
    const general = outs.find((o) => o.general !== undefined)?.general;
    const entry = {
      vehicleId: p.vehicleId,
      ok: okHttp,
      status: (failed || outs[outs.length - 1]).status,
      accepted,
      message: errores ? `${resumen} — ${errores}` : resumen,
      ...(okHttp ? {} : { error: errores || 'envío fallido' }),
      eventos: outs.length,
      payload: p.built.map((b) => b.event),
      response: p.built.map((b, i) => ({ evento: b.event.id_evento, resultado: outs[i].resultado, errores: outs[i].errores })),
      ...(general !== undefined ? { respuestaGeneral: general } : {}),
      raw: p.raw,
      url: CVXR_API_URL,
      groupId,
    };
    await cvxr.appendHistory(entry);
    results.push(entry);
  }
  return results;
}

const cvxr = defineIntegration({
  key: 'cvxr',
  label: 'CVX-R',
  groups: CVXR_GROUPS,
  intervalSec: 60,
  minIntervalSec: 20,
  tickMs: 5000,
  config: () => ({
    url: CVXR_API_URL,
    tokenConfigured: Boolean(TOKEN),
    contratista: CVXR_CONTRATISTA || null,
    rutContratista: RUT_CONTRATISTA || null,
    codigoOperadorGsm: CVXR_CODIGO_OPERADOR_GSM || null,
    backfillMaxMin: BACKFILL_MAX_MS / 60000,
  }),
  // Lo que se enviaría con la última posición (sin enviar ni guardar estado)
  preview: async (obj, pos, { vehicleId }) => buildEvents(obj, vehicleId, [pos], await getState(vehicleId)).map((b) => b.event),
  send,
  routes(app) {
    // Diagnóstico: lo último que CVX-R tiene registrado de este proveedor (GET de su API)
    app.get('/api/cvxr/ultimo', async (_req, res) => {
      if (!TOKEN) return res.json({ ok: false, error: 'CVXR_API_TOKEN no configurado en .env' });
      try {
        const r = await fetch(CVXR_API_URL, {
          headers: { Accept: 'application/json', Authorization: `Bearer ${TOKEN}` },
          signal: AbortSignal.timeout(20000),
        });
        res.json({ ok: r.ok, status: r.status, response: await readBody(r) });
      } catch (err) {
        res.json({ ok: false, status: 0, error: err?.name === 'TimeoutError' ? 'CVX-R no respondió en 20 s' : String(err) });
      }
    });
  },
  warnings: () => [
    ...(TOKEN ? [] : ['CVXR_API_TOKEN no configurado']),
    ...(CVXR_CONTRATISTA && RUT_CONTRATISTA ? [] : ['CVX-R: CVXR_CONTRATISTA / CVXR_RUT_CONTRATISTA vacíos (los eventos van sin contratista)']),
  ],
});

export default cvxr;
