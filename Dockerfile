FROM node:20-alpine

WORKDIR /app/backend

# Install backend dependencies first for better layer caching.
COPY backend/package*.json ./
RUN npm install --omit=dev

# Copy backend source.
COPY backend/ ./

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "index.js"]