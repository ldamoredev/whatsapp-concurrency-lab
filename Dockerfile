# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────────────────────
# build — compila TypeScript. Nada de esta etapa llega a la imagen final.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

WORKDIR /app

# Las dependencias se copian antes que el codigo: mientras package-lock.json no
# cambie, Docker reusa la capa de `npm ci` y el build tarda segundos en vez de minutos.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts

RUN npm run build


# ─────────────────────────────────────────────────────────────────────────────
# runtime — solo lo necesario para correr.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./

# `--omit=dev` deja afuera TypeScript, Vitest y tsx. La imagen de runtime no tiene
# compilador: lo que corre es exactamente lo que se compilo en la etapa anterior.
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Las migraciones viajan en la imagen para que el Job de Kubernetes use el MISMO
# artefacto que la API. Un Job que migrara desde otro lado podria aplicar un schema
# distinto del que la aplicacion espera.
COPY migrations ./migrations

# El panel: HTML, CSS y JS planos, sin build step. Se leen en cada request para poder
# editarlos y recargar sin reconstruir la imagen.
COPY public ./public

# `node` es un usuario sin privilegios que ya trae la imagen oficial. Correr como root
# dentro del contenedor no aporta nada y amplia lo que un exploit puede hacer.
USER node

EXPOSE 3000

# Sin `npm start`: npm quedaria como PID 1 y no reenvia SIGTERM a su hijo. El proceso
# de Node tiene que recibir la señal directamente o el drenaje ordenado nunca corre y
# Kubernetes termina mandando SIGKILL.
CMD ["node", "dist/src/main.js"]
