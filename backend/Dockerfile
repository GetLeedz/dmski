FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . ./

ENV NODE_ENV=production
ENV UPLOAD_DIR=/data/uploads
RUN mkdir -p /data/uploads
EXPOSE 8080

CMD ["node", "index.js"]