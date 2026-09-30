FROM node:24-bookworm-slim AS base

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM build AS check
COPY tests ./tests
COPY scripts ./scripts
COPY .env.example ./
RUN node --test tests/*.test.mjs

FROM base AS e2e-tools
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv g++ cmake make ca-certificates && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/conan && /opt/conan/bin/pip install --no-cache-dir conan==2.32.0
RUN python3 -m venv /opt/conan1 && /opt/conan1/bin/pip install --no-cache-dir conan==1.66.0
ENV PATH="/opt/conan/bin:${PATH}"

FROM e2e-tools AS e2e
WORKDIR /app
COPY --from=check /app /app
CMD ["node", "tests/mock-server.mjs"]

FROM base AS runtime
ENV NODE_ENV=production PORT=9595
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY scripts/container.mjs ./scripts/
USER node
EXPOSE 9595
CMD ["node", "dist/serve.js"]
