# Build from the repository root: docker build -f server/Dockerfile .
FROM node:22-slim

ENV NODE_ENV=production

WORKDIR /srv/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

COPY server/src ./src
COPY shared/projects.json /srv/shared/projects.json

USER node
ENV PORT=8000
EXPOSE 8000
CMD ["node", "src/index.js"]
