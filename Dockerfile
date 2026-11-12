FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
COPY apps/client/package.json apps/client/package.json
COPY apps/server/package.json apps/server/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN npm ci
COPY tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm run build
ENV NODE_ENV=production SFT_HOST=0.0.0.0 SFT_PORT=3000 SFT_REQUIRE_TLS=true
EXPOSE 3000
CMD ["node", "apps/server/dist/index.js"]
