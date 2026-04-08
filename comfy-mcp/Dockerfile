FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --silent
COPY server.mjs ./
ENV NODE_ENV=production
ENTRYPOINT ["node", "server.mjs"]
