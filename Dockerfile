FROM node:24-slim
# the Triton gRPC client (Rust, napi) verifies TLS against the system CA store
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev --no-audit --no-fund
COPY shared ./shared
COPY server ./server
WORKDIR /app/server
ENV NODE_ENV=production DATA_DIR=/data PORT=8080 NODE_OPTIONS=--no-warnings
EXPOSE 8080
CMD ["node", "src/index.ts"]
