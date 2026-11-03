#!/bin/sh
# Install the independent native scalar-export API without restarting pzsolve.
set -eu

DOMAIN="${SEEDLAB_DOMAIN:-}"
REPO="${SEEDLAB_REPO:-/home/ssm-user/seedlab-export-src}"
SERVICE_USER="${SEEDLAB_SERVICE_USER:-ssm-user}"
RUNTIME=/var/lib/seedlab-native
EXPORT_ROOT=$RUNTIME/scalar-exports
ENV_DIR=/etc/seedlab
ENV_FILE=$ENV_DIR/native-api.env
NGINX_CONFIG=/etc/nginx/sites-available/seedlab
SNIPPET=/etc/nginx/snippets/seedlab-scalar-export-proxy.conf
NATIVE_SNIPPET=/etc/nginx/snippets/seedlab-native-proxy.conf
INCLUDE_LINE="include $SNIPPET;"
SERVICE=seedlab-scalar-export-api.service

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi
if [ -z "$DOMAIN" ]; then
  echo "Set SEEDLAB_DOMAIN to the HTTPS hostname, for example api.seedlad.com." >&2
  exit 1
fi
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "Missing service user: $SERVICE_USER" >&2
  exit 1
fi
if [ ! -f "$REPO/package.json" ] || [ ! -f "$REPO/server/scalar-export-api.mjs" ]; then
  echo "Expected an updated Seedlab repository at $REPO" >&2
  exit 1
fi
if [ ! -f "$NGINX_CONFIG" ]; then
  echo "Missing Nginx site: $NGINX_CONFIG" >&2
  exit 1
fi
NODE_BIN=$(command -v node)
USER_HOME=$(getent passwd "$SERVICE_USER" | cut -d: -f6)
node -e 'const major=Number(process.versions.node.split(".")[0]); if (major < 22) process.exit(1)' || {
  echo "Node.js 22 or newer is required." >&2
  exit 1
}

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y build-essential curl git
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 755 "$RUNTIME" "$RUNTIME/bin" "$RUNTIME/source-parent"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 700 "$EXPORT_ROOT"

cd "$REPO"
runuser -u "$SERVICE_USER" -- env HOME="$USER_HOME" npm ci --no-audit --no-fund
runuser -u "$SERVICE_USER" -- env \
  HOME="$USER_HOME" \
  PZSOLVE_SOURCE_DIR="$RUNTIME/source-parent/bitcoin-puzzle-solver" \
  SEEDLAB_ETH_EXPORT_BIN_DIR="$RUNTIME/bin" \
  bash scripts/setup-native-scalar-export.sh

# Reuse the existing native control credential. Never print or commit it.
install -d -o root -g "$SERVICE_USER" -m 750 "$ENV_DIR"
if [ ! -s "$ENV_FILE" ]; then
  TOKEN=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  printf 'NATIVE_PUZZLE_API_TOKEN=%s\n' "$TOKEN" > "$ENV_FILE"
fi
chown root:"$SERVICE_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"

cat > /etc/systemd/system/$SERVICE <<SERVICE_UNIT
[Unit]
Description=Seedlab independent native scalar export API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$REPO
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=8788
Environment=SEEDLAB_ETH_EXPORT_BIN=$RUNTIME/bin/seedlab-eth-export
Environment=NATIVE_SCALAR_EXPORT_ROOT=$EXPORT_ROOT
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN server/scalar-export-api.mjs
Restart=on-failure
RestartSec=3
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=$EXPORT_ROOT

[Install]
WantedBy=multi-user.target
SERVICE_UNIT

install -d -m 755 /etc/nginx/snippets
cat > "$SNIPPET" <<'NGINX'
location ^~ /api/native-scalar-export/ {
    proxy_pass http://127.0.0.1:8788;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Authorization $http_authorization;
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
NGINX

if [ -f "$NATIVE_SNIPPET" ] && grep -Fq "include $NATIVE_SNIPPET;" "$NGINX_CONFIG"; then
  # Reuse exactly the HTTP/HTTPS server blocks where native controls already
  # work, regardless of whether the user browses seedlad.com or api.seedlad.com.
  if ! grep -Fq "$INCLUDE_LINE" "$NATIVE_SNIPPET"; then
    printf '\ninclude %s;\n' "$SNIPPET" >> "$NATIVE_SNIPPET"
  fi
elif ! grep -Fq "$INCLUDE_LINE" "$NGINX_CONFIG"; then
  if ! grep -Fq "server_name $DOMAIN;" "$NGINX_CONFIG"; then
    echo "Set server_name $DOMAIN in $NGINX_CONFIG before running this installer." >&2
    exit 1
  fi
  # Preserve Certbot's HTTP/HTTPS blocks and all existing proxy snippets.
  sed -i "/server_name $DOMAIN;/a\\    $INCLUDE_LINE" "$NGINX_CONFIG"
fi

systemctl daemon-reload
systemctl enable $SERVICE
systemctl restart $SERVICE
nginx -t
systemctl reload nginx

ATTEMPT=0
until curl -fsS --max-time 2 http://127.0.0.1:8788/health >/dev/null 2>&1; do
  ATTEMPT=$((ATTEMPT + 1))
  if [ "$ATTEMPT" -ge 15 ]; then
    systemctl status $SERVICE --no-pager >&2 || true
    exit 1
  fi
  sleep 1
done

printf '\nIndependent scalar export API ready at https://%s/api/native-scalar-export/status\n' "$DOMAIN"
printf 'The service listens only on 127.0.0.1:8788 and requires the existing native bearer token.\n'
printf 'No pzsolve process, puzzle campaign, or seedlab-native-api.service was signalled or restarted.\n'
printf 'Deploy the latest static UI separately with: systemctl start seedlab-deploy.service\n'
