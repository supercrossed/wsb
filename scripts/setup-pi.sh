#!/bin/bash
# Setup script for Orange Pi — run once via: bash ~/wsb/scripts/setup-pi.sh

set -e

USER=$(whoami)
WSB_DIR="/home/$USER/wsb"

echo "=== Setting up WSB Inverse Tracker ==="
echo "User: $USER"
echo "Dir:  $WSB_DIR"

# 1. Create the main app service
echo "--- Creating wsb.service ---"
sudo tee /etc/systemd/system/wsb.service > /dev/null << EOF
[Unit]
Description=WSB Inverse Sentiment Tracker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$WSB_DIR
ExecStart=/usr/bin/node $WSB_DIR/dist/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

# 2. Create the auto-updater script
echo "--- Creating updater script ---"
mkdir -p "$WSB_DIR/scripts"
cat > "$WSB_DIR/scripts/update.sh" << 'UPDATER'
#!/bin/bash
# Checks GitHub for new commits and rebuilds if found

WSB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$WSB_DIR"

# Fetch latest from remote
git fetch origin master --quiet

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/master)

if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0
fi

echo "$(date -Iseconds) Update found: $LOCAL -> $REMOTE"

git pull origin master --quiet
npm install --quiet
npm run build --quiet

sudo systemctl restart wsb
echo "$(date -Iseconds) Update complete, service restarted"
UPDATER
chmod +x "$WSB_DIR/scripts/update.sh"

# 3. Create a systemd timer to check for updates every 5 minutes
echo "--- Creating wsb-updater timer ---"
sudo tee /etc/systemd/system/wsb-updater.service > /dev/null << EOF
[Unit]
Description=WSB Auto Updater
After=network-online.target

[Service]
Type=oneshot
User=$USER
ExecStart=$WSB_DIR/scripts/update.sh
EOF

sudo tee /etc/systemd/system/wsb-updater.timer > /dev/null << EOF
[Unit]
Description=Check for WSB updates every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Persistent=true

[Install]
WantedBy=timers.target
EOF

# 4. Create hourly data feed export (pushes historical data to GitHub for exe users)
echo "--- Creating wsb-data-feed timer ---"
sudo tee /etc/systemd/system/wsb-data-feed.service > /dev/null << EOF
[Unit]
Description=WSB Hourly Data Feed Export
After=network-online.target

[Service]
Type=oneshot
User=$USER
WorkingDirectory=$WSB_DIR
ExecStart=/bin/bash $WSB_DIR/scripts/push-daily-data.sh
EOF

sudo tee /etc/systemd/system/wsb-data-feed.timer > /dev/null << EOF
[Unit]
Description=Export WSB data feed every hour

[Timer]
OnBootSec=5min
OnUnitActiveSec=1h
Persistent=true

[Install]
WantedBy=timers.target
EOF

# 5. Allow the app user to restart wsb without a password
echo "--- Configuring sudoers for passwordless restart ---"
sudo tee /etc/sudoers.d/wsb-updater > /dev/null << EOF
$USER ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart wsb
EOF
sudo chmod 440 /etc/sudoers.d/wsb-updater

# 5. Enable and start everything
echo "--- Enabling services ---"
sudo systemctl daemon-reload
sudo systemctl enable wsb
sudo systemctl enable wsb-updater.timer
sudo systemctl enable wsb-data-feed.timer
sudo systemctl start wsb
sudo systemctl start wsb-updater.timer
sudo systemctl start wsb-data-feed.timer

echo ""
echo "=== Setup complete ==="
echo "App:     sudo systemctl status wsb"
echo "Updater: sudo systemctl list-timers wsb-updater.timer"
echo "Logs:    journalctl -u wsb -f"
echo ""
echo "The app will auto-start on boot and check for GitHub updates every 5 minutes."
