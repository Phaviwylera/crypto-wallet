#!/bin/sh
# Add the persistent native pzsolve API to an existing Seedlab EC2/Nginx host.
# Run as root from the repository checkout after installing Node.js 22 and npm.
set -eu

DOMAIN="${SEEDLAB_DOMAIN:-}"
REPO="${SEEDLAB_REPO:-/home/ssm-user/seedlab-src}"
SERVICE_USER="${SEEDLAB_SERVICE_USER:-ssm-user}"
RUNTIME=/var/lib/seedlab-native
ENV_DIR=/etc/seedlab
ENV_FILE=$ENV_DIR/native-api.env
NGINX_CONFIG=/etc/nginx/sites-available/seedlab
SNIPPET=/etc/nginx/snippets/seedlab-native-proxy.conf
INCLUDE_LINE="include $SNIPPET;"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi
if [ -z "$DOMAIN" ]; then
  echo "Set SEEDLAB_DOMAIN to the HTTPS hostname, for example api.example.com." >&2
  exit 1
fi
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "Missing service user: $SERVICE_USER" >&2
  exit 1
fi
if [ ! -f "$REPO/package.json" ] || [ ! -f "$REPO/server/index.js" ]; then
  echo "Expected the Seedlab repository at $REPO" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js 22 and npm are required." >&2
  exit 1
fi
NODE_BIN=$(command -v node)
USER_HOME=$(getent passwd "$SERVICE_USER" | cut -d: -f6)
node -e 'const major=Number(process.versions.node.split(".")[0]); if (major < 22) process.exit(1)' || {
  echo "Node.js 22 or newer is required." >&2
  exit 1
}
if [ ! -f "$NGINX_CONFIG" ]; then
  echo "Missing Nginx site: $NGINX_CONFIG" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y build-essential curl git

install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 755 \
  "$RUNTIME" "$RUNTIME/bin" "$RUNTIME/campaigns" "$RUNTIME/registry" "$RUNTIME/source-parent"
chmod 700 "$RUNTIME/campaigns" "$RUNTIME/registry"

# Install production Node dependencies and the exact pinned/self-tested runner.
cd "$REPO"
runuser -u "$SERVICE_USER" -- env HOME="$USER_HOME" npm ci --omit=dev --no-audit --no-fund
chown -R "$SERVICE_USER:$SERVICE_USER" "$RUNTIME"
runuser -u "$SERVICE_USER" -- env \
  HOME="$USER_HOME" \
  PZSOLVE_SOURCE_DIR="$RUNTIME/source-parent/bitcoin-puzzle-solver" \
  PZSOLVE_BIN_DIR="$RUNTIME/bin" \
  bash scripts/setup-pzsolve.sh

# Generate a control token once. Existing tokens and all campaign state survive reruns.
install -d -o root -g "$SERVICE_USER" -m 750 "$ENV_DIR"
if [ ! -s "$ENV_FILE" ]; then
  TOKEN=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  printf 'NATIVE_PUZZLE_API_TOKEN=%s\n' "$TOKEN" > "$ENV_FILE"
fi
chown root:"$SERVICE_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"

cat > /etc/systemd/system/seedlab-native-api.service <<SERVICE
[Unit]
Description=Seedlab native pzsolve API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$REPO
Environment=NODE_ENV=production
Environment=STORE_MODE=memory
Environment=PORT=8787
Environment=PZSOLVE_BIN=$RUNTIME/bin/pzsolve
Environment=NATIVE_PUZZLE_CAMPAIGN_ROOT=$RUNTIME/campaigns
Environment=NATIVE_PUZZLE_REGISTRY_ROOT=$RUNTIME/registry
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN server/index.js
Restart=on-failure
RestartSec=3
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=$RUNTIME

[Install]
WantedBy=multi-user.target
SERVICE

# Preserve Certbot's existing HTTP/HTTPS configuration. Add only native/status
# proxy locations; unrelated API endpoints continue to use the static site.
install -d -m 755 /etc/nginx/snippets
cat > "$SNIPPET" <<'NGINX'
location = /health {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}

location = /api/puzzle-campaigns {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}

location ^~ /api/native-puzzle/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Authorization $http_authorization;
    proxy_read_timeout 35s;
}
NGINX

if ! grep -Fq "$INCLUDE_LINE" "$NGINX_CONFIG"; then
  if ! grep -Fq "server_name $DOMAIN;" "$NGINX_CONFIG"; then
    echo "Set server_name $DOMAIN in $NGINX_CONFIG before running this installer." >&2
    exit 1
  fi
  # Certbot commonly leaves HTTP and HTTPS server blocks with the same name.
  # Including the snippet in both is valid; the HTTP redirect still takes effect.
  sed -i "/server_name $DOMAIN;/a\\    $INCLUDE_LINE" "$NGINX_CONFIG"
fi

systemctl daemon-reload
systemctl enable seedlab-native-api.service
systemctl restart seedlab-native-api.service
nginx -t
systemctl reload nginx

ATTEMPT=0
until curl -fsS --max-time 2 http://127.0.0.1:8787/health >/dev/null 2>&1; do
  ATTEMPT=$((ATTEMPT + 1))
  if [ "$ATTEMPT" -ge 15 ]; then
    systemctl status seedlab-native-api.service --no-pager >&2 || true
    exit 1
  fi
  sleep 1
done
curl -fsS --max-time 10 http://127.0.0.1:8787/api/native-puzzle/status >/dev/null

printf '\nNative API setup complete for https://%s\n' "$DOMAIN"
printf 'Status: https://%s/api/native-puzzle/status\n' "$DOMAIN"
printf 'Retrieve the control token locally with: cat %s\n' "$ENV_FILE"
printf 'Do not send that token to chat or commit it. No campaign was started automatically.\n'
