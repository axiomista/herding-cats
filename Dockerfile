# Build on node:22, run on node:22-slim with production dependencies and dist/ only.
FROM node:22 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src src
COPY web web
COPY scripts/copy-web.mjs scripts/copy-web.mjs
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY prompts prompts
COPY config config
COPY seed/answer_key.json seed/answer_key.json
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
