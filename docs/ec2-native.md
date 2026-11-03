# Native pzsolve API on the EC2 website

This adds the same persistent native-C backend used by the local workspace to an existing EC2/Nginx deployment. Nginx continues to serve the built static site and Certbot certificate. Only `/health`, `/api/puzzle-campaigns`, and `/api/native-puzzle/*` are proxied to the Node service on loopback port 8787.

The installer:

- builds the pinned `pzsolve` commit and runs its CPU self-tests;
- installs a `seedlab-native-api.service` systemd service;
- stores campaigns, checkpoints, and registry metadata under `/var/lib/seedlab-native` so releases do not erase them;
- creates a random control token in `/etc/seedlab/native-api.env` and preserves it on reruns;
- preserves the existing Nginx/Certbot server blocks and adds only the required proxy locations;
- does **not** start a campaign automatically.

Public status is read-only and never exposes `FOUND.txt`. Plan/start/stop/resume require the bearer token. Do not run an unauthenticated native control API on a public EC2 instance.

## Prerequisites

Use the existing Ubuntu deployment clone at `/home/ssm-user/seedlab-src`, Node.js 22 or newer, Nginx, and an HTTPS hostname whose `server_name` is already present in `/etc/nginx/sites-available/seedlab`. The examples below use `api.example.com`; substitute the real hostname everywhere.

## Install or update

Update the clean deployment clone to a revision containing this installer, then run:

```bash
cd /home/ssm-user/seedlab-src
sudo SEEDLAB_DOMAIN=api.example.com bash scripts/seedlab-ec2-native-setup.sh
```

The script can be rerun after pulling API changes. It preserves the token and native campaign state. Static releases and the native API have separate update lifecycles; updating static files alone does not update the running Node service.

Verify locally from EC2:

```bash
systemctl status seedlab-native-api.service --no-pager
curl -fsS http://127.0.0.1:8787/health
curl -fsS http://127.0.0.1:8787/api/native-puzzle/status
sudo nginx -t
```

Then verify the public endpoints return JSON rather than the website HTML:

```text
https://api.example.com/health
https://api.example.com/api/native-puzzle/status
```

## Authorize the browser controls

On the EC2 shell, read the token locally:

```bash
cat /etc/seedlab/native-api.env
```

Copy only the value after `NATIVE_PUZZLE_API_TOKEN=`. Do not paste it into chat, GitHub, screenshots, or shell history. In the website's **Native pzsolve address scanner** panel, paste it into **Native API access token**. The token stays in page state and is sent only as the same-origin `Authorization: Bearer …` header for plan/start/stop/resume controls. Refreshing the page clears it.

Choose a published puzzle and a conservative thread count (normally 1–2 on a small EC2 instance), then start or resume a scan. No campaign starts during installation. Native C improves scanning speed but does not make full open-puzzle ranges practical; sustained CPU work can also exhaust burstable-instance CPU credits and increase cost.

## Operations

```bash
# Service logs
journalctl -u seedlab-native-api.service -n 100 --no-pager

# Stop/start only the API; stopping it also stops its owned runner
sudo systemctl stop seedlab-native-api.service
sudo systemctl start seedlab-native-api.service

# Durable native state — back up both directories when migrating hosts
sudo ls -la /var/lib/seedlab-native/campaigns
sudo ls -la /var/lib/seedlab-native/registry
```

The API reports when a match exists but intentionally never returns private-key material. If a campaign reports a match, inspect its `FOUND.txt` directly on the runner host with appropriate access controls.
