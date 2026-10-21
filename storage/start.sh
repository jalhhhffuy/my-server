#!/bin/sh
set -eu
# Render Private Service only. Never expose port 6379 as a public web service.
case "${GAME_STORE_PASSWORD:-}" in
  *[!a-fA-F0-9]*|'') echo 'GAME_STORE_PASSWORD must be 64 hex characters' >&2; exit 1 ;;
esac
[ "${#GAME_STORE_PASSWORD}" -eq 64 ] || exit 1
mkdir -p /var/lib/game-store
# Root on Render disk may own the mount. Use the Valkey image's entrypoint to
# drop privileges after preparing only the mounted data directory.
chown valkey:valkey /var/lib/game-store
exec /usr/local/bin/docker-entrypoint.sh valkey-server /etc/valkey/game-store.conf --requirepass "$GAME_STORE_PASSWORD"
