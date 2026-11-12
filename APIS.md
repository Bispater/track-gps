# APIs · track-service

Documento de referencia de las APIs involucradas en este proyecto.

---

# 1. API ORIGEN · fm-track (Ruptela)

De aquí se **leen** los datos GPS de los camiones.

## Base
- **URL**: `https://api.fm-track.com`
- **Docs**: https://api.fm-track.com/swagger-ui.html · https://www.fmsdocumentation.com/apis/
- **Auth**: API key vía query string `?api_key=<KEY>` (también acepta header `X-Api-Key`)
- **Versión obligatoria**: cada request debe llevar `?version=1` (o `?version=2` según endpoint)
- **Generación de la API key**: vía web del portal fm-track (no por endpoint). La genera un usuario con permisos de administrador.

## Variable de entorno
```
FM_TRACK_API_KEY=<tu key sin llaves ni espacios>
FM_TRACK_VERSION=1
```

## Endpoints que usa la app

### 1.1 GET `/objects` — listar vehículos
Devuelve array directo de objetos.

**Response**:
```json
[
  {
    "id": "5c92ce1c-1b89-11ee-9956-575684d1c077",
    "name": "JH6416",
    "imei": 865851039763826,
    "vehicle_params": {
      "vin": null,
      "make": null,
      "model": null,
      "plate_number": null,
      "average_fuel_consumption": 0,
      "fuel_tank_capacity": null,
      "fuel_type": "DIESEL"
    }
  }
]
```

### 1.2 GET `/objects/{objectId}/coordinates?fromDatetime=X&toDatetime=Y` — histórico de posiciones
Para obtener la última posición se consulta con una ventana de tiempo y se toma el item con `datetime` más reciente.
Ojo: con más de `limit` puntos en la ventana fm-track devuelve los **más antiguos**, así que una
ventana larga (24 h / 7 días) puede dar una "última" posición atrasada.

**Último punto de todos los vehículos (bulk)**: `GET /objects-last-coordinate?version=2&limit=200`
(paginado con `continuation_token`) → `{ results: [{ id, name, imei, vehicle_params, last_coordinate:
{ latitude, longitude, speed, direction, altitude, satellites_count, datetime, last_valid_gps_datetime,
server_datetime } }], continuation_token }`. **No** trae `ignition_status`, `device_inputs` ni
`calculated_inputs`: sirve para saber qué vehículo tiene un punto nuevo, no reemplaza a `/coordinates`.
`version=3` responde 403 en nuestras cuentas (feature no habilitada).

Parámetros opcionales: `limit` (default 100, máx 1000) y `continuationToken` (viene como
`continuation_token` en la respuesta cuando hay más registros que `limit`).

**Carga sobre fm-track.** Un solo recolector (`src/fmtrack.js`) consulta fm-track: cada
`FM_TRACK_POLL_MS` (10 s) pide `/objects-last-coordinate` por cuenta y, solo para los vehículos con un
punto nuevo, `/coordinates` desde su último punto conocido. Los envíos, `/api/snapshot` y el mapa leen
de lo que ya trajo (RAM), sin consultar fm-track en cada pedido. `GET /api/fm-track/stats` muestra las
consultas por minuto. Todos los puntos que llegan se guardan en Postgres (`position_history`). El historial del mapa (`GET /api/vehicles/:id/track`, `src/track-history.js`)
se sirve desde esa tabla; solo consulta fm-track (paginando con `limit`/`continuationToken`) para
rellenar, una única vez, tramos anteriores a lo guardado. El análisis (km por GPS y por odómetro
`calculated_inputs.mileage`, viajes, paradas) está en `src/track-analysis.js`.

**Response**:
```json
{
  "continuation_token": "...",
  "items": [
    {
      "object_id": "5c92ce1c-1b89-11ee-9956-575684d1c077",
      "datetime": "2026-05-15T18:32:25.000Z",
      "ignition_status": "OFF",
      "position": {
        "latitude": -36.5441766,
        "longitude": -72.0891283,
        "altitude": 117,
        "direction": 271,
        "speed": 0,
        "satellites_count": 23
      },
      "device_inputs": {
        "power_supply_voltage": 12736,
        "hdop": "0.6",
        "temperature_sensor_0": 11.8,
        "digital_input_1": false,
        "first_driver_id": null,
        "...": "..."
      },
      "calculated_inputs": {
        "mileage": 867758.27
      }
    }
  ]
}
```

### 1.3 Campos relevantes para nuestros adaptadores

| Campo fm-track | Tipo | Notas |
|---|---|---|
| `object_id` | string (UUID) | identificador interno |
| `name` | string | suele tener la patente (ej. `JH6416`) |
| `imei` | number | IMEI del equipo GPS |
| `vehicle_params.plate_number` | string \| null | patente "oficial"; en este tenant viene `null` |
| `datetime` | string ISO 8601 UTC | hora de la posición |
| `position.latitude` / `longitude` | number | grados decimales |
| `position.altitude` | int | metros |
| `position.direction` | int | grados (0-360) |
| `position.speed` | int | km/h |
| `position.satellites_count` | int | nº satélites visibles |
| `ignition_status` | enum | `"ON"` \| `"OFF"` \| `"UNKNOWN"` |
| `device_inputs.hdop` | string | calidad GPS (ej. `"0.6"`) |
| `device_inputs.temperature_sensor_0..3` | float \| null | sensores de temperatura en °C |

---

# 2. API DESTINO #1 · Q Analytics (inserta_posiciones)

Envío de posiciones GPS al sistema Q Analytics.

## Base
- **URL TEST**: `https://ww3.qanalytics.cl/Api_InsertaPosicion_General_test/inserta_posiciones/`
- **Método**: `POST`
- **Auth**: `Authorization: Bearer <token>` (token obtenido del módulo "Generar Token" de Q Analytics)

## Variables de entorno
```
QA_API_URL=https://ww3.qanalytics.cl/Api_InsertaPosicion_General_test/inserta_posiciones/
QA_API_TOKEN=<bearer token>
```

## Body
Array JSON con uno o más objetos de posición:

```json
[
  {
    "COD_VEH": "5c92ce1c-1b89-11ee-9956-575684d1c077",
    "PLACA": "JH6416",
    "LAT": -36.544177,
    "LON": -72.089128,
    "FH_SVR_GPS": "2026-05-15T18:32:25.000Z",
    "FH_RPT_GPS": "2026-05-15T18:32:25.000Z",
    "VEL": 0,
    "SENT": 271,
    "CANT_SAT": 23,
    "HDOP": 0.6,
    "IGN": 0,
    "ALT": 117
  }
]
```

## Campos del payload

| Campo | Tipo | Rango | Obligatorio | Origen fm-track |
|---|---|---|---|---|
| `COD_VEH` | VARCHAR(50) | — | sí | `object.id` |
| `PLACA` | VARCHAR(100) | alfanumérica, sin guiones | sí | `vehicle_params.plate_number` o `name` |
| `LAT` | NUMERIC(9,6) | — | sí | `position.latitude` |
| `LON` | NUMERIC(9,6) | — | sí | `position.longitude` |
| `FH_SVR_GPS` | DATETIME UTC ISO 8601 | — | sí | `datetime` |
| `FH_RPT_GPS` | DATETIME UTC ISO 8601 | — | sí | `datetime` |
| `VEL` | INT | 0-1000 | sí | `position.speed` |
| `SENT` | INT | 0-360 | sí | `position.direction` |
| `CANT_SAT` | INT | 0-100 | sí | `position.satellites_count` |
| `HDOP` | NUMERIC(4,1) | 0-100 | sí | `device_inputs.hdop` (default `1.0`) |
| `IGN` | INT | 0 \| 1 | sí | `ignition_status === "ON" ? 1 : 0` |
| `ALT` | INT | -2000 a 100000 | no | `position.altitude` |
| `POR_BAT_VEH`, `RPM`, `TEMP1-4`, etc. | varios | — | no | opcionales según docs |

## Respuestas
- **200 OK** → `{"message": "Posiciones insertadas correctamente"}`
- **400 Bad Request** → errores de validación con detalle por campo
- **401 Unauthorized** → token inválido

---

# 3. API DESTINO #2 · Falabella TMS (GPS Aggregator)

Envío de posiciones GPS al TMS de Falabella.

## Base
- **URL TEST**: `https://tms-uat-services.falabella.supply/api/v1/ms-tms-gps-aggregator/gps/position`
- **URL PROD**: `https://tms-services.falabella.supply/api/v1/ms-tms-gps-aggregator/gps/position` *(creds entregadas tras validar TEST)*
- **Método**: `POST`

## Headers requeridos

| Header | Valor | Notas |
|---|---|---|
| `apikey` | `wQ20Lk4TA5TqZYoKRDThzfQbe10gMfQ8` *(TEST)* | API key entregada por Falabella |
| `authorization` | `93d2724f-d826-44a4-a753-d1939b86e4b1` *(TEST)* | Token único por prestador GPS |
| `x-country` | `CL` \| `AR` \| `PE` \| `CO` \| `MX` | País del consumidor |
| `X-txref` | UUID v4 | identificador único de transacción, no debe modificarse |
| `User-Agent` | `gps/1.0.0` | identificador del prestador `sistema/version` |
| `Content-Type` | `application/json` | |

## Variables de entorno
```
FALABELLA_TEST_URL=https://tms-uat-services.falabella.supply/api/v1/ms-tms-gps-aggregator/gps/position
FALABELLA_PROD_URL=https://tms-services.falabella.supply/api/v1/ms-tms-gps-aggregator/gps/position
FALABELLA_APIKEY=wQ20Lk4TA5TqZYoKRDThzfQbe10gMfQ8
FALABELLA_AUTHORIZATION=93d2724f-d826-44a4-a753-d1939b86e4b1
FALABELLA_PROD_APIKEY=
FALABELLA_PROD_AUTHORIZATION=
FALABELLA_PROVIDER_DNI=<RUT/DNI del prestador>
FALABELLA_PROVIDER_NAME=<nombre del prestador>
FALABELLA_X_COUNTRY=CL
FALABELLA_USER_AGENT=gps/1.0.0
```

## Body (`RequestGPSPosition`)

```json
{
  "provider": { "id": "18618839K", "description": "Favric" },
  "vehicleId": "JH6416",
  "referenceId": "5c92ce1c-1b89-11ee-9956-575684d1c077",
  "latitude": -36.544177,
  "longitude": -72.089128,
  "timestamp": "2026-05-15T18:32:25.000Z",
  "speed": { "value": 0, "unit": "KILOMETER" },
  "ignited": false,
  "heading": 271,
  "sensors": [
    { "type": "temperature", "sensor": "temperature_sensor_0", "value": 11.8, "unit": "C" }
  ]
}
```

## Campos del payload

| Campo | Tipo | Obligatorio | Origen fm-track | Notas |
|---|---|---|---|---|
| `provider.id` | string | sí (≥4 chars) | (config) | DNI/RUT del prestador GPS — pese a que el PDF lo llama "DNI", el campo se llama `id` |
| `provider.description` | string | sí | (config) | nombre comercial del prestador — el PDF lo llama "nombre", el campo es `description` |
| `vehicleId` | string | sí | `vehicle_params.plate_number` o `name` | **patente sin guiones** |
| `referenceId` | string | sí | `object.id` | id adicional; si no existe, usar el mismo `vehicleId` |
| `latitude` | number | sí | `position.latitude` | 6 decimales |
| `longitude` | number | sí | `position.longitude` | 6 decimales |
| `timestamp` | string ISO 8601 | sí | `datetime` | con zona horaria; si no, se asume UTC 0 |
| `speed.value` | number | sí | `position.speed` | velocidad |
| `speed.unit` | enum | sí | — | **`"KILOMETER"` \| `"MILE"`** (no `km/h`) |
| `ignited` | bool | no | `ignition_status === "ON"` | |
| `heading` | int | no | `position.direction` | |
| `sensors[]` | array | no | `device_inputs.temperature_sensor_*` | solo `temperature` está habilitado actualmente |

## Respuestas

| Código | Significado |
|---|---|
| **200 OK** + `{"id": "uuid"}` | Posición recibida y registrada correctamente |
| **200 OK** + `{"message": "NO_TRACKING_CONFIGURED"}` | La patente **no está habilitada** todavía en el ambiente (avisar al equipo TMS Falabella) |
| **400 Bad Request** | Error de validación en payload (ver `message`) |
| **401 Unauthorized** | Token/apikey inválido o deshabilitado |
| **500 Internal Server Error** | Error en Falabella. Guardar payload + `X-txref` y reportar al equipo TMS |

## Notas importantes (sacadas de la doc)
- Enviar **1 posición por vehículo cada 20 segundos** (deseable).
- Si el GPS pierde señal, **encolar** y al reconectarse enviar las posiciones perdidas **de manera secuencial** cada 10 segundos.
- Para TEST hay que **informar las patentes** al equipo TMS Falabella para que las habiliten antes de probar.
- Las credenciales de PROD se entregan **solo después** de validar la integración en TEST.
- Monitorear las transacciones (ok/fallidas) — se recomienda guardar payloads de respuestas 500.

---

# 4. API DESTINO · CVX-R (StartSee · recepción GPS)

Código: `src/integrations/cvxr.js`.

## Base
- **URL**: `POST https://startsee.cvx-r.cl/api/v1/gps`
- **Docs**: https://startsee.cvx-r.cl/api/v1/docs/ (la spec OpenAPI está embebida en `swagger-ui-init.js`)
- **Auth**: `Authorization: Bearer <API key>` (la entrega CVX-R)
- **Diagnóstico**: `GET` a la misma URL devuelve el último evento que recibieron de este proveedor
  (en la app: `GET /api/cvxr/ultimo`). En nov-2026 este GET tardaba más de 60 s sin responder.

## Reglas de la doc
- Body = array de `EventoGPS`, **máx 300 por request**, ordenado del más antiguo al más nuevo.
- Con contacto encendido, un evento cada **1 min** como máximo; apagado, cada **10 min**.
- Si el contacto no está conectado, informar `contacto: true` en cada evento.

Por eso el adapter no manda solo la última posición: manda todos los puntos que el equipo
registró desde el último evento entregado (consulta fm-track desde ese momento, hasta
`CVXR_BACKFILL_MAX_MIN` atrás). La primera vez manda solo la última. El estado por vehículo
(último evento entregado, contacto, odómetro al encender) se guarda en `app_meta` (`cvxr_state:<id>`).

## Campos del payload

| Campo | Origen | Notas |
|---|---|---|
| `id_evento` | `imei` + epoch en segundos | estable: reenviar el mismo punto da WARN "duplicado" |
| `patente` | `plate_number` \| `name` | sin guion, máx 10 |
| `numero_interno` | — | `0` (no usado) |
| `contratista` / `rut_contratista` | `.env` | obligatorios para CVX-R |
| `fecha_hora_evento` | `datetime` | UTC, `yyyy-MM-ddTHH:mm:ssZ` |
| `fecha_hora_recepcion` | `datetime` | fm-track no informa cuándo lo recibió |
| `latitud` / `longitud` / `direccion` / `velocidad` / `altitud` / `satelites` | `position.*` | |
| `hdop` | `device_inputs.hdop` | `0` si no viene |
| `contacto` | `ignition_status !== "OFF"` | desconocido → encendido (regla de la doc) |
| `tipo_evento` | — | `1` si el contacto cambió respecto al evento anterior, si no `0` |
| `velocidad_maxima` | — | `0` (doc: "0 si no está disponible") |
| `distancia_recorrida_viaje` | `calculated_inputs.mileage` − odómetro al encender | `0` con contacto apagado |
| `distancia_recorrida_total` | `calculated_inputs.mileage` | km |
| `voltaje_bateria_vehiculo` | `device_inputs.power_supply_voltage` / 1000 | mV → V; `0` si no viene |
| `voltaje_bateria_gps` | — | `0` (fm-track no lo informa) |
| `gsm_signal` | — | `0` (fm-track no lo informa) |
| `conductor` / `rut_conductor` | `.env` (`CVXR_CONDUCTOR`, `CVXR_RUT_CONDUCTOR`) | obligatorios para CVX-R |
| `codigo_operador_gsm` | `.env` (`CVXR_CODIGO_OPERADOR_GSM`) | obligatorio para CVX-R |
| `green_driving`, `green_driving_valor`, `tipo_dato_opcional` | — | `0` |
| `dato_opcional` | — | `{}` |

La doc no marca obligatorios, pero el primer envío real (2026-11-11) respondió 400 exigiendo
`contratista`, `rut_contratista`, `hdop`, `codigo_operador_gsm`, `gsm_signal`, `conductor`,
`rut_conductor`, `voltaje_bateria_vehiculo` y `voltaje_bateria_gps`. Los numéricos que fm-track no
entrega van en `0`; los de texto salen del `.env` y, si están vacíos, CVX-R rechaza el evento.

## Respuestas
Un resultado por evento: `{ "evento": "<id_evento>", "resultado": "OK" | "WARN" | "ERROR", "errores": { "<campo>": ["..."] } }`

| Código | Significado | Qué hace el adapter |
|---|---|---|
| **200** + `OK` | Registrado | avanza |
| **200** + `WARN` | Duplicado: ya lo tenían | avanza (cuenta como aceptado) |
| **400** + `ERROR` | Datos rechazados (ej. `patente: Patente no habilitada`) | registra el error y avanza (reenviarlo daría lo mismo) |
| **401**, **429**, **5xx**, sin respuesta | Token inválido / límite / falla de ellos | no avanza: se reintenta en el próximo ciclo |

---

# 5. API PROPIA (salida) · Accesos API — solo lectura para clientes

Al revés que los destinos: aquí el **cliente nos consulta** a nosotros. Cada acceso (panel → *Accesos API*)
tiene usuario, token y la lista de patentes que puede ver. Código: `src/api-externa.js`; tabla `api_access`.

## Endpoint
```
GET https://proaseg.cl/api/externo/v1/posiciones
GET https://proaseg.cl/api/externo/v1/posiciones?patente=AB1234,CD5678   (solo esas; las no autorizadas se ignoran)
```
Caddy ya enruta `/api/*` al backend: no hubo que tocar Caddy. La ruta se registra **antes** del login del
panel (autentica con su propio token; la cookie del panel no sirve aquí y el token no sirve en el panel).

## Autenticación (cualquiera)
- `Authorization: Bearer <token>`
- `Authorization: Basic base64(usuario:token)` (usuario y contraseña; la contraseña es el token)
- `X-API-Key: <token>`

Token `psg_` + 32 caracteres aleatorios. Se guarda solo su SHA-256 y se muestra una vez (al crear o
regenerar). Regenerar o eliminar invalida el anterior al instante.

## Respuesta
```json
{
  "fecha_consulta": "2026-11-11T12:45:00-03:00",
  "total": 1,
  "vehiculos": [
    { "patente": "AB1234", "latitud": -33.4489, "longitud": -70.6693,
      "fecha_hora": "2026-11-11T12:42:10-03:00", "velocidad": 54, "ignicion": true }
  ]
}
```
| Campo | Origen fm-track | Nota |
|---|---|---|
| `patente` | `vehicle_params.plate_number` \| `name` | sin guion (misma regla que los envíos) |
| `latitud` / `longitud` | `position.latitude` / `.longitude` | |
| `fecha_hora` | `datetime` | ISO 8601 en hora de Chile con offset (`America/Santiago`) |
| `velocidad` | `position.speed` | km/h, entero |
| `ignicion` | `ignition_status` | `ON` → true, `OFF` → false, otro → null |

Una patente autorizada sin punto de los últimos 7 días (o que no existe en fm-track) va con los datos en `null`.

## Datos y límites
- Lee lo que el recolector de fm-track ya tiene en RAM (se actualiza cada ~10 s): **no genera consultas a fm-track**.
- Medido en prod (2026-11-11): con motor encendido los equipos reportan cada ~30 s (mediana); apagados, cada ~4–5 min.
- Límite por acceso: `limite_minuto` consultas por ventana móvil de 60 s (por defecto 2, editable 1–60).
  Sobre eso: **429** + `Retry-After`. Otros errores: **401** credenciales inválidas, **403** acceso desactivado.
- Uso: `consultas`, `limitadas`, `last_used_at`, `last_ip` por acceso; altas/cambios/bajas en `activity_log` (`kind = 'api_access'`).
- Registro (`api_access_log`, 90 días): cada consulta respondida o rechazada con fecha, IP, método, status,
  `resultado` (`ok`, `limite`, `desactivado`, `token_invalido`, `usuario_desconocido`, `sin_credenciales`, `error`),
  vehículos entregados / con posición, filtro, user-agent y ms. Un rechazo con Basic y un usuario que existe queda en
  ese acceso, con los últimos 4 caracteres del token usado (para ver si usa uno regenerado). Sin acceso identificable →
  `access_id` NULL. Tope: 30 filas por acceso y 10 por IP sin identificar por minuto (lo demás se responde igual).

## Rutas del panel (exigen sesión)
`GET /api/accesos` (incluye `ok24h`, `errores24h`, `ultimoError` y `sinIdentificar7d`) · `POST /api/accesos` (devuelve el token) ·
`PUT /api/accesos/:id` · `POST /api/accesos/:id/token` (regenera) · `DELETE /api/accesos/:id` (borra también su registro) ·
`GET /api/accesos/:id/preview` · `GET /api/accesos/:id/registro?errores=1&limit=100` ·
`GET /api/accesos/sin-identificar` (rechazos de los últimos 7 días sin acceso) ·
`GET /api/accesos/vehiculos` (patentes que reconoce el backend).

---

# Mapeo resumido fm-track → destinos

| fm-track | Q Analytics | Falabella |
|---|---|---|
| `object.id` | `COD_VEH` | `referenceId` |
| `vehicle_params.plate_number` \| `name` | `PLACA` (sin guiones) | `vehicleId` (sin guiones) |
| `position.latitude` | `LAT` | `latitude` |
| `position.longitude` | `LON` | `longitude` |
| `datetime` | `FH_SVR_GPS` / `FH_RPT_GPS` | `timestamp` |
| `position.speed` | `VEL` (int) | `speed.value` |
| `position.direction` | `SENT` (int) | `heading` |
| `position.satellites_count` | `CANT_SAT` | — |
| `device_inputs.hdop` | `HDOP` (default 1.0) | — |
| `ignition_status === "ON"` | `IGN` (1\|0) | `ignited` (bool) |
| `position.altitude` | `ALT` (opcional) | — |
| `device_inputs.temperature_sensor_*` | (opcional `TEMP1-4`) | `sensors[]` con `type:"temperature"` |
