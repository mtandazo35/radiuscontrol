FROM node:22-bookworm-slim AS compilacion
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM caddy:2
COPY despliegue/Caddyfile /etc/caddy/Caddyfile
COPY --from=compilacion /web/dist /srv
