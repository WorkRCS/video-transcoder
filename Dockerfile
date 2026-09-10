FROM node:20-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY package.json ./
RUN npm install --omit=dev

COPY nest-cli.json tsconfig.json ./
COPY src ./src
COPY public ./public

RUN npm run web:build && npx nest build

RUN mkdir -p /app/data/jobs /app/data/uploads
EXPOSE 3000

CMD ["node", "dist/main.js"]
