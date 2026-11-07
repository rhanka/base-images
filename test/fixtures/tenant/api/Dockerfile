FROM ghcr.io/rhanka/base/node-dev:26@sha256:1111111111111111111111111111111111111111111111111111111111111111 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM ghcr.io/rhanka/base/node:26@sha256:2222222222222222222222222222222222222222222222222222222222222222
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
CMD ["dist/index.js"]
