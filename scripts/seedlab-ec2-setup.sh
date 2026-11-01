#!/bin/sh
# One-shot setup for EC2 direct-poll deployment of the public static site.
# Run as root on Ubuntu after installing nginx, git, Node.js 22, and npm.
set -eu

REPO=/home/ssm-user/seedlab-src
ROOT=/var/www/seedlab

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi
if [ ! -d "$REPO/.git" ]; then
  echo "Expected the Git clone at $REPO; clone main there first." >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js and npm are required; install Node.js 22 first." >&2
  exit 1
fi

install -d -o ssm-user -g ssm-user -m 755 "$ROOT" "$ROOT/releases"

cat > /usr/local/sbin/seedlab-deploy <<'DEPLOY'
#!/bin/sh
set -eu

REPO=/home/ssm-user/seedlab-src
ROOT=/var/www/seedlab

git -C "$REPO" fetch --quiet --depth=1 origin +refs/heads/main:refs/remotes/origin/main
SHA="$(git -C "$REPO" rev-parse refs/remotes/origin/main)"

CURRENT_SHA=""
if [ -L "$ROOT/current" ]; then
  CURRENT_SHA="$(basename "$(readlink -f "$ROOT/current")")"
fi
if [ "$CURRENT_SHA" = "$SHA" ] && [ -s "$ROOT/current/index.html" ]; then
  echo "Already deployed: $SHA"
  exit 0
fi

BUILD_DIR="$(mktemp -d "$HOME/seedlab-build.XXXXXX")"
trap 'rm -rf "$BUILD_DIR"' 0
git -C "$REPO" archive --format=tar --output="$BUILD_DIR/source.tar" "$SHA"
tar -xf "$BUILD_DIR/source.tar" -C "$BUILD_DIR"
cd "$BUILD_DIR"
npm ci --no-audit --no-fund
npm run build
test -s dist/index.html

RELEASE_DIR="$ROOT/releases/$SHA"
mkdir -p "$RELEASE_DIR"
cp -a dist/. "$RELEASE_DIR/"
chmod -R a+rX "$RELEASE_DIR"
ln -sfn "$RELEASE_DIR" "$ROOT/current.new"
mv -Tf "$ROOT/current.new" "$ROOT/current"
echo "Deployed $SHA"
DEPLOY
chmod 755 /usr/local/sbin/seedlab-deploy

cat > /etc/nginx/sites-available/seedlab <<'NGINX'
server {
    listen 80 default_server;
    server_name _;
    root /var/www/seedlab/current;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
NGINX
ln -sfn /etc/nginx/sites-available/seedlab /etc/nginx/sites-enabled/seedlab
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable --now nginx
systemctl reload nginx

cat > /etc/systemd/system/seedlab-deploy.service <<'SERVICE'
[Unit]
Description=Build and deploy the latest Seedlab main branch
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=ssm-user
Group=ssm-user
Environment=HOME=/home/ssm-user
WorkingDirectory=/home/ssm-user/seedlab-src
ExecStart=/usr/local/sbin/seedlab-deploy
SERVICE

cat > /etc/systemd/system/seedlab-deploy.timer <<'TIMER'
[Unit]
Description=Check GitHub main for Seedlab updates every two minutes

[Timer]
OnBootSec=30s
OnUnitActiveSec=2min
Persistent=true
Unit=seedlab-deploy.service

[Install]
WantedBy=timers.target
TIMER
systemctl daemon-reload
systemctl enable --now seedlab-deploy.timer
systemctl start seedlab-deploy.service

echo "Setup complete. Check: systemctl status seedlab-deploy.timer --no-pager"
echo "Site URL: http://$(curl -fsS --max-time 5 https://checkip.amazonaws.com 2>/dev/null || echo EC2-PUBLIC-IP)/"
echo "Note: this site is HTTP-only; do not enter real wallet secrets."
