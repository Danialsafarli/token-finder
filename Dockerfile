# Token Finder - one long-lived Node 24 process: dashboard, scanner, chain
# collection and deep intelligence, over one SQLite database on a volume.
#
# Zero runtime dependencies: Node runs the TypeScript sources directly, so the
# image is the Node runtime plus src/. No build step, no node_modules.
# See DEPLOYMENT.md.

FROM node:24-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    TOKEN_FINDER_DATA_DIR=/data \
    TRUST_PROXY=true

WORKDIR /app
COPY package.json ./
COPY src ./src

# The database lives on a mounted volume at /data, owned by the unprivileged user.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080

# Liveness only: readiness (/readyz) is for the platform's routing checks.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# SIGTERM closes the database cleanly (src/core/store.ts) before exit.
STOPSIGNAL SIGTERM
CMD ["node", "src/cli.ts", "serve"]
