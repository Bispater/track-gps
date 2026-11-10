// =============================================================
// Falabella TMS (GPS Aggregator) · un POST por vehículo
// =============================================================
// Ambiente test/prod por grupo, con credenciales separadas. Responde 200 + {id} si registró
// la posición, o 200 + {message:"NO_TRACKING_CONFIGURED"} si la patente no está habilitada.
import crypto from 'node:crypto';
import { env } from '../config.js';
import { resolveVehicleIds } from '../fmtrack.js';
import { pick, readBody, round, rawPlate, plainPlate, toIsoLocal } from '../util.js';
import { defineIntegration, eachVehicle, NO_POSITION } from './base.js';

const {
  FALABELLA_TEST_URL = 'https://tms-uat-services.falabella.supply/api/v1/ms-tms-gps-aggregator/gps/position',
  FALABELLA_PROD_URL = 'https://tms-services.falabella.supply/api/v1/ms-tms-gps-aggregator/gps/position',
  FALABELLA_APIKEY = '',
  FALABELLA_AUTHORIZATION = '',
  FALABELLA_PROD_APIKEY = '',
  FALABELLA_PROD_AUTHORIZATION = '',
  FALABELLA_X_COUNTRY = 'CL',
  FALABELLA_USER_AGENT = 'gps/1.0.0',
  FALABELLA_PROVIDER_DNI = '',
  FALABELLA_PROVIDER_NAME = '',
  FALABELLA_TIMEZONE = 'America/Santiago',
  FALABELLA_GROUPS = '',
  ALLOWED_GROUPS = '',
} = env;

function buildPayload(obj, pos, providerOverride) {
  // Falabella espera provider.id (RUT/DNI) y provider.description (nombre).
  // El env y la UI siguen usando "dni"/"name" por compatibilidad; aquí se renombra.
  const provider = {
    id: providerOverride?.dni || providerOverride?.id || FALABELLA_PROVIDER_DNI || '',
    description: providerOverride?.name || providerOverride?.description || FALABELLA_PROVIDER_NAME || '',
  };
  // vehicleId: la patente (sin guiones). referenceId: el id interno fm-track.
  const vehicleId = plainPlate(rawPlate(obj) || pick(obj, ['id']));
  const referenceId = String(pick(obj, ['id', 'object_id']) || pick(pos, ['object_id']) || vehicleId);
  // sensors omitidos: Falabella exige un campo `code` por sensor que la doc pública no especifica.
  // Cuando TMS aclare el schema requerido, agregar el `code` y re-habilitar el envío.
  return {
    provider,
    vehicleId,
    referenceId,
    latitude: round(pick(pos, ['position.latitude']), 6, 0),
    longitude: round(pick(pos, ['position.longitude']), 6, 0),
    // ISO 8601 con zona horaria: hora local con offset (mismo instante)
    timestamp: toIsoLocal(pick(pos, ['datetime']), FALABELLA_TIMEZONE),
    speed: { value: Number(pick(pos, ['position.speed']) ?? 0), unit: 'KILOMETER' },
    ignited: pick(pos, ['ignition_status']) === 'ON',
    heading: Number(pick(pos, ['position.direction']) ?? 0),
  };
}

async function sendOne({ payload, env: ambiente = 'test', x_country, txref }) {
  const url = ambiente === 'prod' ? FALABELLA_PROD_URL : FALABELLA_TEST_URL;
  const apikey = ambiente === 'prod' ? FALABELLA_PROD_APIKEY : FALABELLA_APIKEY;
  const authz = ambiente === 'prod' ? FALABELLA_PROD_AUTHORIZATION : FALABELLA_AUTHORIZATION;
  if (!apikey || !authz) return { ok: false, status: 0, response: { error: `credenciales ${ambiente} no configuradas en .env` }, txref };
  const txr = txref || crypto.randomUUID();
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'apikey': apikey,
    'authorization': authz,
    'x-country': x_country || FALABELLA_X_COUNTRY,
    'X-txref': txr,
    'User-Agent': FALABELLA_USER_AGENT,
  };
  try {
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    const body = await readBody(r);
    const accepted = r.ok && body && typeof body === 'object' && body.id;
    return { ok: r.ok, status: r.status, accepted: Boolean(accepted), response: body, txref: txr, url };
  } catch (err) {
    return { ok: false, status: 0, response: { error: String(err) }, txref: txr, url };
  }
}

async function send({ groupId, vehicleIds, env: ambiente, x_country, providerOverride, txref }) {
  const config = groupId ? falabella.groups[groupId] || {} : null;
  const ids = await resolveVehicleIds(groupId, vehicleIds);
  if (!ids.length) return [];
  const useEnv = ambiente || config?.env || 'test';
  return eachVehicle(ids, {
    groupId,
    append: falabella.appendHistory,
    noPosition: `${NO_POSITION} (vehículo apagado/sin reportar)`,
    noPositionExtra: { env: useEnv },
  }, async ({ vehicleId, obj, pos }) => {
    const payload = buildPayload(obj, pos, providerOverride || config?.provider);
    const r = await sendOne({ payload, env: useEnv, x_country: x_country || config?.x_country, txref });
    return { vehicleId, ...r, payload, raw: pos, groupId };
  });
}

const falabella = defineIntegration({
  key: 'falabella',
  label: 'Falabella',
  groups: FALABELLA_GROUPS || ALLOWED_GROUPS,
  intervalSec: 20,
  minIntervalSec: 5,
  groupDefaults: () => ({
    env: 'test',
    x_country: FALABELLA_X_COUNTRY || 'CL',
    provider: null, // null = usa el default del .env
  }),
  config: () => ({
    testUrl: FALABELLA_TEST_URL,
    prodUrl: FALABELLA_PROD_URL,
    apikeyTestConfigured: Boolean(FALABELLA_APIKEY),
    apikeyProdConfigured: Boolean(FALABELLA_PROD_APIKEY),
    defaultCountry: FALABELLA_X_COUNTRY,
    defaultProvider: { dni: FALABELLA_PROVIDER_DNI, name: FALABELLA_PROVIDER_NAME },
    userAgent: FALABELLA_USER_AGENT,
  }),
  updateGroup(body, next) {
    if (body.env != null) next.env = String(body.env);
    if (body.x_country != null) next.x_country = String(body.x_country);
    if (body.provider) next.provider = { ...(next.provider || {}), ...body.provider };
  },
  preview: (obj, pos, { groupId }) => buildPayload(obj, pos, groupId ? falabella.groups[groupId]?.provider : undefined),
  sendOptions: ({ env: ambiente, x_country, providerOverride }) => ({ env: ambiente, x_country, providerOverride }),
  send,
  warnings: () => [
    ...(!FALABELLA_APIKEY || !FALABELLA_AUTHORIZATION ? ['Credenciales Falabella TEST no configuradas'] : []),
    ...(!FALABELLA_PROD_APIKEY || !FALABELLA_PROD_AUTHORIZATION ? ['Credenciales Falabella PROD no configuradas'] : []),
  ],
});

export default falabella;
