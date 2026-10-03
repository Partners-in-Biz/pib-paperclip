#!/usr/bin/env bash
# Install or update the PiB client post approval service on the VPS (run as root, from this folder).
# Idempotent: a second run copies the files again and restarts the service; the database password is created once and
# kept in /root/pib-ops/approval.env (mode 600). Nothing here prints the password.
#
# Order of work (the orchestrator does this after deploying plugin-social 0.8.0, whose migration 015 creates the table):
#   1. bash install.sh          (role + grants, files, unit, start)
#   2. add the Caddy lines from README.md and `systemctl reload caddy`
#   3. curl -s http://127.0.0.1:3032/a/health        -> ok
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP=/home/paperclip/pib-approval
ENV_FILE=/root/pib-ops/approval.env
UNIT=/etc/systemd/system/pib-approval.service

[ "$(id -u)" = "0" ] || { echo "run as root" >&2; exit 1; }
for f in server.mjs render.mjs pib-approval.service setup.sql; do [ -f "$SRC/$f" ] || { echo "missing $SRC/$f" >&2; exit 1; }; done

# The table comes from the plugin's migration: stop early when it is not there yet.
if ! sudo -u postgres psql -d paperclip -X -At -c "SELECT to_regclass('plugin_social_e70c4e79f2.client_approvals')" | grep -q client_approvals; then
  echo "plugin_social_e70c4e79f2.client_approvals does not exist: deploy plugin-social 0.8.0 first (migration 015)" >&2
  exit 1
fi

# Password: generated once, never printed.
if [ ! -f "$ENV_FILE" ]; then
  PASSWORD="$(head -c 32 /dev/urandom | base64 | tr -d '/+=\n' | cut -c1-32)"
  install -d -m 700 "$(dirname "$ENV_FILE")"
  ( umask 077; printf 'PORT=3032\nAPPROVAL_DATABASE_URL=postgres://pib_approval:%s@127.0.0.1:5432/paperclip\n' "$PASSWORD" > "$ENV_FILE" )
else
  PASSWORD="$(sed -n 's#^APPROVAL_DATABASE_URL=postgres://pib_approval:\([^@]*\)@.*#\1#p' "$ENV_FILE")"
  [ -n "$PASSWORD" ] || { echo "$ENV_FILE exists but has no APPROVAL_DATABASE_URL" >&2; exit 1; }
fi
chmod 600 "$ENV_FILE"

# Role and grants. The password reaches psql on its standard input (a \set line), never on a command line.
{ printf '%s\n' "\\set approval_password '$PASSWORD'"; cat "$SRC/setup.sql"; } | sudo -u postgres psql -d paperclip -X -q -v ON_ERROR_STOP=1 -f - >/dev/null

install -d -o paperclip -g paperclip -m 700 "$APP"
install -o paperclip -g paperclip -m 644 "$SRC/server.mjs" "$SRC/render.mjs" "$APP/"
install -m 644 "$SRC/pib-approval.service" "$UNIT"
systemctl daemon-reload
systemctl enable pib-approval >/dev/null 2>&1
systemctl restart pib-approval
# The service needs a moment to start and open its database connection: retry the health check instead of failing on the first try.
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS http://127.0.0.1:3032/a/health >/dev/null 2>&1; then break; fi
  [ "$attempt" = "10" ] && { echo "pib-approval did not become healthy; see: journalctl -u pib-approval -n 30" >&2; exit 1; }
  sleep 1
done
systemctl is-active pib-approval
curl -fsS http://127.0.0.1:3032/a/health && echo
