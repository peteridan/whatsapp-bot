FROM node:20-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        fonts-liberation \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000
ENV BAILEYS_AUTH_PATH=/data/.baileys_auth
ENV GROQ_MODEL=llama-3.3-70b-versatile

RUN mkdir -p /app /data/.baileys_auth

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY bot-core.js ./
COPY lib ./lib
COPY public ./public

EXPOSE ${PORT}

CMD ["node", "bot-core.js"]