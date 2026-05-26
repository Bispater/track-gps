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
**No existe** un endpoint bulk de "last known position".

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
