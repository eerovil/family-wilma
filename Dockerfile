FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY assets ./assets
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/assets ./assets

# The analysis cache lives here; mount it as a volume so it survives a restart.
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME /app/data

USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
