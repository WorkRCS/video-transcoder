FROM node:20-bookworm-slim AS builder

WORKDIR /app
COPY package.json ./
RUN npm install
COPY nest-cli.json tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM node:20-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY package.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public

RUN mkdir -p /app/data/jobs /app/data/uploads
EXPOSE 3000

CMD ["node", "dist/main.js"]
