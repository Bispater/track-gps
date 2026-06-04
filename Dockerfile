FROM node:20-alpine

WORKDIR /app

# Instalar deps primero (capa cacheable)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Código del backend (API-only: el frontend Angular se sirve en su propio contenedor)
COPY server.js db.js ./

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Healthcheck: /api/health responde sin auth si el server vive
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O- http://localhost:3000/api/health > /dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
