#!/usr/bin/env bash
# Builds the server and client and deploys them to the VM (docs/poc/04-deployment.md).
#
#   scripts/deploy.sh <ssh-key> [user@host]        # default host: opc@listening-together.duckdns.org
#
# Keeps a timestamped backup of the previous jar and client on the VM, restarts the service, and checks that the
# API answers. Rooms live in memory: a deploy ends every room in progress.
set -euo pipefail

KEY=${1:?usage: scripts/deploy.sh <ssh-key> [user@host]}
HOST=${2:-opc@listening-together.duckdns.org}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SSH=(ssh -i "$KEY" -o BatchMode=yes)

echo "== build"
(cd "$ROOT/server" && ./mvnw -q package -DskipTests)
(cd "$ROOT/client" && npm run build --silent)

echo "== upload to $HOST"
"${SSH[@]}" "$HOST" 'rm -rf /tmp/lt-deploy && mkdir -p /tmp/lt-deploy/client'
scp -q -i "$KEY" "$ROOT"/server/target/server-*.jar "$HOST:/tmp/lt-deploy/server.jar"
scp -q -r -i "$KEY" "$ROOT"/client/dist/. "$HOST:/tmp/lt-deploy/client/"

echo "== install and restart"
"${SSH[@]}" "$HOST" 'bash -s' <<'REMOTE'
set -euo pipefail
TS=$(date +%Y%m%d-%H%M%S)
sudo cp -a /opt/listening/server.jar "/opt/listening/server.jar.bak-$TS"
sudo cp -a /srv/listening/client "/srv/listening/client.bak-$TS"
sudo cp /tmp/lt-deploy/server.jar /opt/listening/server.jar
sudo find /srv/listening/client -mindepth 1 -delete
sudo cp -r /tmp/lt-deploy/client/. /srv/listening/client/
# SELinux (Oracle Linux): files must get the target directory's context, not /tmp's.
sudo restorecon -R /opt/listening /srv/listening/client
sudo systemctl restart listening
code=000
for _ in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/rooms/x || true)
  [ "$code" = 404 ] && break
  sleep 1
done
rm -rf /tmp/lt-deploy
echo "listening: $(systemctl is-active listening), API check: HTTP $code (404 expected for an unknown room)"
[ "$code" = 404 ]
REMOTE

echo "== done: https://${HOST#*@}/"
