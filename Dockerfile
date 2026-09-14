# Skeleton. This builds and runs today, but the entry point is a placeholder
# that prints a message and exits — there is no application yet.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# The analysis cache lives here; mount it as a volume so it survives a restart.
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME /app/data

USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
