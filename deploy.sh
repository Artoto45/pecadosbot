#!/usr/bin/env bash
# ─── Deploy Script — Bot AutoReply ──────────────────────────────────────
# Uso: ./deploy.sh <user@server> [port]
# Ejemplo: ./deploy.sh root@123.456.789.0
# ─────────────────────────────────────────────────────────────────────────

set -euo pipefail

SERVER="${1:?Uso: $0 user@server}"
PORT="${2:-22}"
LOCAL_DIR="$(dirname "$0")"
REMOTE_DIR="/opt/bot-autoreply"

echo "🚀 Deploying Bot AutoReply to $SERVER..."

# ── 1. Sync code ────────────────────────────────────────────────────────
echo "📁 Syncing files..."
rsync -avz --delete \
  --exclude 'node_modules/' \
  --exclude '__pycache__/' \
  --exclude '*.pyc' \
  --exclude '.env.local' \
  --exclude 'wa_auth/' \
  --exclude '*.log' \
  --exclude 'wa_qr.png' \
  "$LOCAL_DIR/" "$SERVER:$REMOTE_DIR/"

# ── 2. SSH setup ────────────────────────────────────────────────────────
ssh -t "$SERVER" "
set -euo pipefail

cd '$REMOTE_DIR'

echo '📦 Installing Python deps...'
pip install flask gunicorn 2>/dev/null || pip3 install flask gunicorn

echo '📦 Installing Node deps...'
npm install --production

echo '🔧 Creating .env.local with token...'
if [ ! -f .env.local ]; then
  echo 'AUTOREPLY_BOT_TOKEN=TU_TOKEN_AQUI' > .env.local
  echo '⚠️  EDIT .env.local con tu token real!'
fi

echo '🐍 Testing bot...'
python bot.py &
BOT_PID=\$!
sleep 3
kill \$BOT_PID 2>/dev/null || true
echo '✅ Bot OK'

echo '🟢 Creating systemd service for Telegram bot...'
cat <<'SERVICEBOT' | sudo tee /etc/systemd/system/bot-autoreply-tg.service > /dev/null
[Unit]
Description=Bot AutoReply Telegram
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$REMOTE_DIR
EnvironmentFile=$REMOTE_DIR/.env.local
ExecStart=$(which python) bot.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICEBOT

echo '🟢 Creating systemd service for WhatsApp bot...'
cat <<'SERVICEWA' | sudo tee /etc/systemd/system/bot-autoreply-wa.service > /dev/null
[Unit]
Description=Bot AutoReply WhatsApp
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$REMOTE_DIR
ExecStart=$(which node) wa_bot.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICEWA

echo '🟢 Creating systemd service for Admin Panel...'
cat <<'SERVICEPANEL' | sudo tee /etc/systemd/system/bot-autoreply-panel.service > /dev/null
[Unit]
Description=Bot AutoReply Admin Panel
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$REMOTE_DIR
EnvironmentFile=$REMOTE_DIR/.env.local
# Un solo worker conserva de forma coherente los retos Telethon y los cambios
# transaccionales; los workers de canal corren en procesos separados.
ExecStart=$(which gunicorn) -w 1 --threads 4 -b 0.0.0.0:5000 app:app
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICEPANEL

echo '🔄 Reloading systemd...'
sudo systemctl daemon-reload
sudo systemctl enable bot-autoreply-tg bot-autoreply-wa bot-autoreply-panel

echo '🚀 Starting services...'
sudo systemctl start bot-autoreply-tg
sudo systemctl start bot-autoreply-panel
# WhatsApp requiere escanear QR primero, se inicia manual:
echo '⚠️  WhatsApp: sudo systemctl start bot-autoreply-wa, luego escanea QR en http://IP:5000'

echo ''
echo '✅ Deploy completo!'
echo '📱 Telegram bot:  sudo systemctl status bot-autoreply-tg'
echo '💬 WhatsApp bot:  sudo systemctl start bot-autoreply-wa  (luego escanea QR)'
echo '🖥️  Admin Panel:   http://IP_DEL_SERVIDOR:5000'
"
