#!/usr/bin/env bash
# uninstall.sh — Remove o DeepsProxy do usuário atual (atalho + comando + dados).
set -eu

DEST="$HOME/.local/share/DeepsProxy"
BIN_LINK="$HOME/.local/bin/deepsproxy"

"$DEST/deepsproxy" stop >/dev/null 2>&1 || true

rm -f "$BIN_LINK"
rm -f "$HOME/.local/share/applications/DeepsProxy.desktop"
rm -f "$HOME/.config/autostart/DeepsProxy.desktop"
rm -rf "$DEST"

echo "DeepsProxy removido."