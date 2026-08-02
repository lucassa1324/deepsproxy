FROM mcr.microsoft.com/playwright:v1.59.1-noble

# Tela virtual + VNC para o login remoto (noVNC no navegador)
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    x11vnc \
    novnc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

RUN npx playwright install chromium || true

ENV NODE_ENV=production
ENV OPEN_UI=false
ENV ENABLE_VNC=true
ENV DISPLAY=:99

EXPOSE 3005 5900

CMD ["bash", "/app/entrypoint.sh"]
