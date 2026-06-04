# Deploy · track (backend + frontend + Postgres)

Guía para subir el stack completo a un VPS con Docker + Caddy (HTTPS automático).

El stack son **4 contenedores** orquestados desde `track-service/docker-compose.yml`:

| Servicio   | Qué es                            | Imagen / build              |
|------------|-----------------------------------|-----------------------------|
| `db`       | Postgres (estado persistente)     | `postgres:16-alpine`        |
| `backend`  | API Node/Express (`server.js`)    | build de `track-service/`   |
| `frontend` | SPA Angular servido por Nginx     | build de `../track-frontend`|
| `caddy`    | Reverse proxy + TLS automático    | `caddy:2-alpine`            |

Ruteo: `proaseg.cl/api/*` → `backend`; todo lo demás (el SPA) → `frontend`.

---

## Requisitos previos

1. **Un VPS Linux** (Ubuntu 22.04+). Hetzner / DigitalOcean / Vultr sirven.
2. **El dominio `proaseg.cl` apuntando al IP del VPS** (registro DNS tipo A), **antes**
   del primer arranque — Caddy lo necesita para sacar el certificado SSL.
3. **Las dos carpetas como hermanas** en el VPS:
   ```
   ~/track-service/    ← aquí corre docker compose
   ~/track-frontend/   ← build context del frontend
   ```

---

## Setup inicial del VPS

```bash
ssh root@TU.IP.DEL.VPS
apt update && apt upgrade -y
curl -fsSL https://get.docker.com | sh

# (opcional) usuario no-root
adduser deploy && usermod -aG docker deploy && su - deploy
```

Subir ambos proyectos (desde tu máquina, manteniéndolos hermanos):
```bash
rsync -avz --exclude node_modules --exclude dist --exclude .git \
  ~/Desktop/track-service/  deploy@TU.IP.DEL.VPS:~/track-service/
rsync -avz --exclude node_modules --exclude dist --exclude .git --exclude .env \
  ~/Desktop/track-frontend/ deploy@TU.IP.DEL.VPS:~/track-frontend/
```

---

## Configuración

### 1. `.env` del backend (en `track-service/`)
```bash
cd ~/track-service
cp .env.example .env
nano .env
```
Llenar credenciales reales (FM_TRACK_API_KEY, Falabella, Wise, etc.) y **definir**:
- `AUTH_SECRET` → un valor largo y aleatorio (ej: `openssl rand -hex 32`).
- `POSTGRES_PASSWORD` y la misma clave dentro de `DATABASE_URL`.

### 2. `Caddyfile`
```bash
cp Caddyfile.example Caddyfile
nano Caddyfile        # confirmar que el dominio sea proaseg.cl
```

---

## Arrancar

```bash
cd ~/track-service
docker compose up -d --build
```

Verificar:
```bash
docker compose ps                 # los 4 contenedores Up (db/backend healthy)
docker compose logs -f backend    # "[db] schema listo" y "track-service · http://localhost:3000"
docker compose logs -f caddy      # "certificate obtained"
```

Visitar `https://proaseg.cl` — Caddy ya dejó el certificado solo.

---

## Operación

### Actualizar SOLO el frontend (no corta los envíos GPS)
```bash
# tras sincronizar ~/track-frontend
docker compose up -d --build frontend
```
El `backend` y sus schedulers siguen corriendo sin interrupción.

### Actualizar SOLO el backend
```bash
docker compose up -d --build backend
```
Al reiniciar retoma la config y los schedulers desde Postgres (no se pierde estado).

### Logs / reinicio
```bash
docker compose logs -f backend
docker compose restart backend
```

### Backup de la base de datos
```bash
docker compose exec db pg_dump -U track track > backup-$(date +%F).sql
```
Restaurar:
```bash
cat backup-AAAA-MM-DD.sql | docker compose exec -T db psql -U track track
```

### Empezar de cero (borrar TODOS los registros)
```bash
docker compose down
docker volume rm track-service_pgdata     # ⚠ borra toda la base
docker compose up -d --build
```

### Bajar todo
```bash
docker compose down        # detiene (conserva el volumen pgdata)
docker compose down -v     # detiene + BORRA volúmenes (incluida la base) ⚠
```

---

## Modo "sin Caddy" (acceso por IP, sin dominio)

Útil para probar antes de tener el DNS listo:
```bash
docker compose -f docker-compose.yml -f docker-compose.no-tls.yml up -d --build
```
Expone el frontend en el puerto 80 (Nginx sirve el SPA y proxea `/api` al backend).
Acceder a `http://TU.IP.DEL.VPS`. Abrir el puerto 80 en el firewall.

---

## Troubleshooting

**`backend` reinicia en loop / "no se pudo conectar a Postgres"**
- `docker compose logs db` — ¿`database system is ready to accept connections`?
- Confirmar que `DATABASE_URL` apunta al host `db` y la clave coincide con `POSTGRES_PASSWORD`.

**Caddy no consigue el certificado**
- `dig proaseg.cl +short` debe devolver el IP del VPS.
- El puerto 80 debe estar abierto (Let's Encrypt valida por HTTP-01).

**El frontend carga pero la API da 401/404**
- Revisar el ruteo en el `Caddyfile` (`handle /api/*` → `backend:3000`).
- `docker compose logs backend` para ver si llega la request.

**Cambios en `.env` no se reflejan**
- `docker compose up -d backend` (recrea el contenedor con el nuevo env).
