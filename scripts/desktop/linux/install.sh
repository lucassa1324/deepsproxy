#!/usr/bin/env bash
# install.sh — Instala o DeepsProxy para o usuário atual (sem sudo).
#
# Copia a pasta para ~/.local/share/DeepsProxy e cria:
#   - atalho no menu de aplicativos (~/.local/share/applications/DeepsProxy.desktop)
#   - comando `deepsproxy` em ~/.local/bin
#   - opcionalmente, início automático com o sistema (~/.config/autostart)
#
# Não precisa de terminal: dê dois cliques ou rode  ./install.sh
set -eu

SRC="$(cd "$(dirname -- "$0")" && pwd)"
DEST="${1:-$HOME/.local/share/DeepsProxy}"
BIN_DIR="$HOME/.local/bin"
APPS_DIR="$HOME/.local/share/applications"
AUTOSTART_DIR="$HOME/.config/autostart"

echo "== Instalando DeepsProxy em $DEST"

mkdir -p "$DEST" "$BIN_DIR" "$APPS_DIR"

cp -a "$SRC/." "$DEST/"
chmod +x "$DEST/deepsproxy" "$DEST/node"

# Comando `deepsproxy` no PATH do usuário.
ln -sf "$DEST/deepsproxy" "$BIN_DIR/deepsproxy"
echo "✔ Comando disponível: ~/.local/bin/deepsproxy"
echo "  (se não funcionar no terminal, adicione ~/.local/bin ao PATH)"

# Atalho no menu de aplicativos.
sed "s|__APP_DIR__|$DEST|g" "$DEST/DeepsProxy.desktop" > "$APPS_DIR/DeepsProxy.desktop"
chmod +x "$APPS_DIR/DeepsProxy.desktop"
echo "✔ Atalho criado no menu de aplicativos."

# Início automático (opcional).
if [ "${AUTO_START:-n}" = "y" ]; then
  mkdir -p "$AUTOSTART_DIR"
  cp "$APPS_DIR/DeepsProxy.desktop" "$AUTOSTART_DIR/"
  echo "✔ Início automático habilitado."
fi

echo ""
echo "Pronto! Procure por \"DeepsProxy\" no menu de aplicativos"
echo "ou rode:  deepsproxy"