FROM node:22-alpine
WORKDIR /app
# sharp ships prebuilt binaries for alpine via libvips; no native build needed.
COPY package.json ./
RUN npm install --omit=dev --silent
COPY server.mjs ./
ENV NODE_ENV=production
ENV PORT=80
EXPOSE 80
ENTRYPOINT ["node", "server.mjs"]
