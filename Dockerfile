FROM node:22-alpine AS builder
WORKDIR /app

RUN npm install -g pnpm@11.21.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server.mjs ./server.mjs
COPY --from=builder /app/LICENSE ./LICENSE
COPY --from=builder /app/package.json ./package.json

EXPOSE 8787
USER node
CMD ["node", "server.mjs", "--host", "0.0.0.0", "--port", "8787"]
