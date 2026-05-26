FROM node:20-alpine

WORKDIR /app

# Instalar deps primero (capa cacheable)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copiar el resto del proyecto
COPY server.js ./
COPY public ./public

# Logs y schedules se persisten en /app/logs (montar como volumen)
RUN mkdir -p /app/logs

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Healthcheck básico: el endpoint /api/config siempre responde si el server vive
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O- http://localhost:3000/api/config > /dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
