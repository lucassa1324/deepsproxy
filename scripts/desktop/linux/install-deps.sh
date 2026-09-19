#!/usr/bin/env bash
# install-deps.sh — Instala (com sudo) as bibliotecas de sistema que o Chromium
# embutido precisa, nos gestores de pacotes mais comuns (apt/dnf/pacman).
# Só é necessário se o DeepsProxy não abrir por libs ausentes.
set -eu

echo "== Instalando dependências do navegador do DeepsProxy =="
echo "Isso pedirá sua senha (sudo)."

if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 libglib2.0-0 \
    fonts-liberation
elif command -v dnf >/dev/null 2>&1; then
  sudo dnf install -y nss nspr atk at-spi2-atk cups-libs libdrm libxkbcommon \
    libXcomposite libXdamage libXfixes libXrandr libgbm alsa-lib pango cairo \
    glib2 liberation-fonts
elif command -v pacman >/dev/null 2>&1; then
  sudo pacman -S --needed --noconfirm nss nspr at-spi2-core cups \
    libxkbcommon libxcomposite libxdamage libxfixes libxrandr libdrm \
    pango cairo alsa-lib glib2 ttf-liberation
else
  echo "Gestor de pacotes não identificado. Instale manualmente:"
  echo "  libnss3, libatk, libcups, libxkbcommon, libgbm, libasound2, pango, cairo"
fi

echo "Concluído. Tente abrir o DeepsProxy novamente."