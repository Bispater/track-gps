// =============================================================
// Wise (Wisetrack) · un POST con todas las posiciones del grupo (máx 300)
// =============================================================
// Responde un estado por posición (tabla WISE_ESTADO). Reglas propias:
//   - estado 4 (móvil no existe) → el vehículo queda bloqueado y no se reenvía
//   - no reinyectar una posición ya aceptada (dedupe por datetime, persistido en last_sent)
//   - mínimo 20 s entre llamadas
import * as db from '../db.js';
import { env } from '../config.js';
import { resolveVehicleIds } from '../fmtrack.js';
import { pick, readBody, clampInt, rawPlate, plateWithHyphen, formatUtc } from '../util.js';
import { defineIntegration, eachVehicle } from './base.js';

const {
  WISE_API_URL = 'https://gw2.wisetrack.cl/Sotraser/1.0/InsertarPosicion',
  WISE_API_TOKEN = '',
  WISE_GROUPS = '',
} = env;

const MAX_PER_REQUEST = 300;

// Tabla de estados de la respuesta Wise
const WISE_ESTADO = {
  1: 'OK',
  2: 'Error de conversión',
  3: 'Token inválido',
  4: 'Móvil no existe o no disponible',
  5: 'Registro duplicado',
  6: 'Error interno',
};
const estadoText = (e) => `${e}: ${WISE_ESTADO[e] || 'Estado ' + e}`;

// ---------- payload ----------
// lat/lng como string con coma decimal
function toWiseCoord(n) {
  if (n == null || !Number.isFinite(Number(n))) return '';
  return Number(n).toFixed(6).replace('.', ',');
}
// Spec Wisetrack v1.1: la fecha del GPS va en UTC, formato yyyy-MM-dd HH:mm:ss
function toWiseDatetime(ts) {
  const d = new Date(ts || Date.now());
  return isNaN(d.getTime()) ? '' : formatUtc(d);
}
// Una posición (item del array `posicion`)
function buildItem(obj, pos) {
  // Wisetrack registra las patentes con guión (ej: "GRJB-61"). Se normaliza por si fm-track
  // la trae sin guión, para evitar el estado 4 ("móvil no existe").
  const patente = plateWithHyphen(rawPlate(obj) || pick(obj, ['id']) || '');
  const lat = pick(pos, ['position.latitude']);
  const lng = pick(pos, ['position.longitude']);
  const ignOn = pick(pos, ['ignition_status']) === 'ON';
  const item = {
    patente,
    fecha_hora: toWiseDatetime(pick(pos, ['datetime'])),
    latitud: toWiseCoord(lat),
    longitud: toWiseCoord(lng),
    direccion: String(clampInt(pick(pos, ['position.direction']), 0, 359, 0)),
    velocidad: String(clampInt(pick(pos, ['position.speed']), 0, 999, 0)),
    estado: (lat != null && lng != null) ? '1' : '0',
    estado_ignicion: ignOn ? '1' : '0',
    // Evento: 45 = posición online con ignición, 46 = motor apagado
    numero_evento: ignOn ? '45' : '46',
  };
  // Sensor de temperatura: solo si fm-track lo trae con valor
  const temp = pick(pos, ['device_inputs.temperature_sensor_0']);
  if (temp != null && Number.isFinite(Number(temp))) item.sensor_a1 = String(Number(temp));
  return item;
}

// ---------- respuesta ----------
// El detalle trae la patente como primer dato del paréntesis:
//   "Registro duplicado. (FCCS23, 2026-06-07 08:09:58, 46)"  → patente = FCCS23
// OJO: la API real responde "DetalleOperacion" (el doc lo llamaba "DetalleEjecucion").
function extractPatente(detalle) {
  if (!detalle || typeof detalle !== 'string') return null;
  const m = detalle.match(/\(([^,)]+)/);
  return m ? m[1].trim().toUpperCase() : null;
}
// [{ estado, patente, detalle }], uno por ResultadoTransaccion
function parseResults(body) {
  if (!body || typeof body !== 'object') return [];
  const rop = body?.RespuestaServicioWeb?.RespuestaOperacion;
  if (rop == null) return [];
  return (Array.isArray(rop) ? rop : [rop]).map((o) => {
    const rt = o?.ResultadoTransaccion || {};
    const estado = Number(rt.Estado);
    const detalle = rt.DetalleOperacion ?? rt.DetalleEjecucion ?? null;
    return { estado: Number.isFinite(estado) ? estado : null, patente: extractPatente(detalle), detalle };
  });
}

async function postBatch(payload) {
  if (!WISE_API_TOKEN) {
    return { ok: false, status: 0, accepted: false, response: { error: 'WISE_API_TOKEN no configurado en .env' }, url: WISE_API_URL };
  }
  try {
    const r = await fetch(WISE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        Authorization: `Bearer ${WISE_API_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });
    const body = await readBody(r);
    const results = parseResults(body);
    const estados = results.map((x) => x.estado).filter((e) => e != null);
    return {
      ok: r.ok,
      status: r.status,
      accepted: estados.length > 0 && estados.every((e) => e === 1),
      estados,
      results,
      message: estados.length ? estados.map(estadoText).join(' · ') : 'sin estado en respuesta',
      response: body,
      url: WISE_API_URL,
    };
  } catch (err) {
    return { ok: false, status: 0, accepted: false, response: { error: String(err) }, url: WISE_API_URL };
  }
}

// ---------- estado propio ----------
// Vehículos que Wisetrack dijo que no existen (estado 4): no se reenvían hasta darlos de alta.
let blocked = new Set();
// Último datetime aceptado por vehículo (spec: no reinyectar posiciones ya aceptadas)
const lastSentDatetime = new Map();

async function send({ groupId, vehicleIds }) {
  const ids = await resolveVehicleIds(groupId, vehicleIds);
  if (!ids.length) return [];

  const items = []; // { vehicleId, payloadItem, raw, datetime }
  const results = await eachVehicle(ids, {
    groupId,
    append: wise.appendHistory,
    skip: (vid) => blocked.has(String(vid)) &&
      { vehicleId: vid, ok: false, accepted: false, error: 'vehículo bloqueado (no existe en Wisetrack)', groupId },
    stopWhen: () => items.length >= MAX_PER_REQUEST,
  }, ({ vehicleId, obj, pos }) => {
    const datetime = pick(pos, ['datetime']);
    if (lastSentDatetime.get(String(vehicleId)) === datetime) {
      return { vehicleId, ok: true, accepted: false, skipped: true, message: 'sin cambios (mismo datetime)', groupId, raw: pos };
    }
    items.push({ vehicleId, payloadItem: buildItem(obj, pos), raw: pos, datetime });
  });
  if (!items.length) return results;

  const batch = await postBatch({ posicion: items.map((x) => x.payloadItem) });
  const estados = batch.estados || [];
  // Estado de cada vehículo: por patente (el detalle la trae); si no calza, por orden.
  const estadoByPatente = new Map();
  for (const r of batch.results || []) {
    if (r.patente != null && r.estado != null) estadoByPatente.set(r.patente, r.estado);
  }
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const patente = String(it.payloadItem?.patente || '').toUpperCase();
    const estado = estadoByPatente.has(patente) ? estadoByPatente.get(patente) : estados[i];
    const accepted = estado === 1;
    if (estado === 4) {
      blocked.add(String(it.vehicleId));
      await db.addBlocked('wise', it.vehicleId, 'no existe en Wisetrack (estado 4)');
    }
    // 1 (aceptado) o 5 (duplicado: Wisetrack YA la tiene) → no reinyectarla hasta que haya una nueva
    if (accepted || estado === 5) {
      lastSentDatetime.set(String(it.vehicleId), it.datetime);
      await db.saveLastSent('wise', it.vehicleId, it.datetime);
    }
    const entry = {
      vehicleId: it.vehicleId,
      ok: batch.ok,
      status: batch.status,
      accepted,
      estados: estado != null ? [estado] : [],
      message: estado != null ? estadoText(estado) : 'sin estado en respuesta',
      response: batch.response,
      payload: { posicion: [it.payloadItem] },
      raw: it.raw,
      url: batch.url,
      groupId,
      batchSize: items.length,
    };
    await wise.appendHistory(entry);
    results.push(entry);
  }
  return results;
}

const wise = defineIntegration({
  key: 'wise',
  label: 'Wise',
  groups: WISE_GROUPS,
  // Wise exige >=20 s entre llamadas; recomienda 30-60 s para evento online (45)
  intervalSec: 30,
  minIntervalSec: 20,
  config: () => ({ url: WISE_API_URL, tokenConfigured: Boolean(WISE_API_TOKEN) }),
  preview: (obj, pos) => ({ posicion: [buildItem(obj, pos)] }),
  send,
  async init() {
    blocked = await db.loadBlocked('wise');
    for (const [k, v] of await db.loadLastSent('wise')) lastSentDatetime.set(k, v);
  },
  routes(app) {
    app.get('/api/wise/blocked', (_req, res) => {
      res.json({ vehicleIds: Array.from(blocked) });
    });
    app.delete('/api/wise/blocked/:id', async (req, res) => {
      const id = String(req.params.id);
      blocked.delete(id);
      await db.removeBlocked('wise', id);
      res.json({ ok: true });
    });
    app.post('/api/wise/blocked/clear', async (_req, res) => {
      blocked.clear();
      await db.clearBlocked('wise');
      res.json({ ok: true });
    });
  },
  warnings: () => (WISE_API_TOKEN ? [] : ['WISE_API_TOKEN no configurado']),
});

export default wise;
