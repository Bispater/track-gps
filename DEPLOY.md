# Deploy · track-service

Guía para subir esta app a un VPS con Docker + Caddy (HTTPS automático).

---

## Requisitos previos

1. **Un VPS Linux** (Ubuntu 22.04+ recomendado). Opciones baratas:
   - Hetzner Cloud CX11 — €4.5/mes
   - DigitalOcean Droplet — USD 6/mes
   - Vultr Cloud Compute — USD 5/mes
2. **Un dominio o subdominio** apuntando al IP del VPS (registro DNS tipo A).
   - Ejemplo: `track.tudominio.cl` → IP del VPS.
   - **Esto debe estar listo antes** del primer arranque — Caddy necesita resolver el dominio para sacar el certificado SSL.

---

## Setup inicial del VPS

```bash
# 1. Conectarse al VPS
ssh root@TU.IP.DEL.VPS

# 2. Actualizar sistema
apt update && apt upgrade -y

# 3. Instalar Docker
curl -fsSL https://get.docker.com | sh

# 4. (opcional) Crear usuario no-root para correr el servicio
adduser deploy
usermod -aG docker deploy
su - deploy

# 5. Clonar este repo (o subirlo con scp/rsync)
git clone <tu-repo-url> track-service
cd track-service
```

Si no tienes el repo en git, lo más rápido es subirlo desde tu máquina:
```bash
rsync -avz --exclude node_modules --exclude logs --exclude .env \
  ./ deploy@TU.IP.DEL.VPS:/home/deploy/track-service/
```

---

## Configuración

### 1. Crear `.env` en el VPS
```bash
cp .env.example .env
nano .env
```
Llenar con los valores reales (FM_TRACK_API_KEY, QA_API_TOKEN, credenciales Falabella, etc.).

### 2. Crear `Caddyfile`
```bash
cp Caddyfile.example Caddyfile
nano Caddyfile
```
Reemplazar `track.tudominio.cl` por tu dominio real.

---

## Arrancar

```bash
docker compose up -d --build
```

Verificar:
```bash
docker compose ps               # ambos contenedores running
docker compose logs -f app      # logs de la app
docker compose logs -f caddy    # logs de Caddy (debería decir "certificate obtained")
```

Visitar `https://track.tudominio.cl` desde el navegador — Caddy ya configuró el certificado solo.

---

## Operación

### Ver logs en vivo
```bash
docker compose logs -f app
```

### Reiniciar
```bash
docker compose restart app
```

### Actualizar a una nueva versión
```bash
git pull                              # o re-sync con rsync
docker compose up -d --build app      # rebuild solo el app, no toques caddy
```

### Backup
Los datos persistentes (schedules, historiales, grupos) viven en `./logs/`:
```bash
tar czf backup-$(date +%F).tgz logs/
```

### Bajar todo
```bash
docker compose down                   # detiene
docker compose down -v                # detiene + borra volúmenes de Caddy (NO los logs)
```

---

## Modo "sin Caddy" (acceso directo en puerto 3000)

Útil para probar antes de comprar dominio o como dev en el VPS:

1. En `docker-compose.yml` descomentar las líneas `ports: - "3000:3000"` en el servicio `app`.
2. Comentar o eliminar el servicio `caddy`.
3. Abrir el puerto 3000 en el firewall del VPS.
4. Acceder a `http://TU.IP.DEL.VPS:3000`.

---

## Múltiples apps bajo el mismo dominio

Cuando agregues otra app en el mismo VPS, en `Caddyfile`:

```
track.tudominio.cl {
    reverse_proxy app:3000
}

otra.tudominio.cl {
    reverse_proxy other-app:4000
}
```

Y agregar el otro servicio al `docker-compose.yml` (en la misma red de docker-compose ya se ven entre sí por nombre).

---

## Troubleshooting

**Caddy no consigue el certificado**
- Verificar que el DNS resuelve: `dig track.tudominio.cl +short` debe devolver el IP del VPS.
- Verificar que el puerto 80 esté abierto (Let's Encrypt valida por HTTP-01).
- Ver `docker compose logs caddy`.

**App no responde**
- `docker compose ps` — ¿está `Up (healthy)`?
- `docker compose logs app` — buscar errores en el arranque (típico: variable `.env` faltante).

**Cambios en `.env` no se reflejan**
- Hay que reiniciar el contenedor: `docker compose restart app`.

**Cambios en `Caddyfile` no se reflejan**
- `docker compose restart caddy` (o `docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile`).
