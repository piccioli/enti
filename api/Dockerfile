FROM node:20-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit
COPY src/ ./src/
COPY scripts/ ./scripts/

EXPOSE 3000
CMD ["node", "src/index.js"]
