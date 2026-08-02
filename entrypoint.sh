#!/usr/bin/env bash
set -e

export DISPLAY=:99

echo "[entrypoint] Iniciando tela virtual (Xvfb :99)..."
Xvfb :99 -screen 0 1600x1000x24 -nolisten tcp &
XVFB_PID=$!

sleep 2

echo "[entrypoint] Iniciando VNC (x11vnc na porta 5900)..."
x11vnc -display :99 -forever -shared -nopw -quiet -rfbport 5900 &
X11VNC_PID=$!

echo "[entrypoint] Iniciando deepsproxy na porta ${PORT:-3005}..."
exec npm start
