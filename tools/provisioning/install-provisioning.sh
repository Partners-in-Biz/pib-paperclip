#!/usr/bin/env bash
# Installs the provisioning runner on the VPS (run as root by Peet's Cowork session after the PR is approved).
#   install-provisioning.sh           install or update
#   install-provisioning.sh --check   change nothing; exit 0 only if everything is in place and current
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
OPS=/root/pib-ops
SPOOL=/var/spool/pib-provision
CHECK=0; [ "${1:-}" = "--check" ] && CHECK=1
FAIL=0
bad() { echo "MISSING/STALE: $1"; FAIL=1; }

# source -> destination -> mode
FILES=(
  "provision-runner.py|$OPS/provision-runner.py|0755"
  "provision_steps.py|$OPS/provision_steps.py|0644"
  "provision-policy.json|$OPS/provision-policy.json|0644"
  "pib-provision-request|/usr/local/bin/pib-provision-request|0755"
  "pib-provision-runner.service|/etc/systemd/system/pib-provision-runner.service|0644"
  "pib-provision-runner.path|/etc/systemd/system/pib-provision-runner.path|0644"
)

for e in "${FILES[@]}"; do
  IFS='|' read -r s d m <<<"$e"
  [ -f "$SRC/$s" ] || continue  # provision_steps.py arrives in the second PR
  if [ "$CHECK" = 1 ]; then
    cmp -s "$SRC/$s" "$d" || bad "$d"
  elif [ "$s" = provision-policy.json ] && [ -f "$d" ]; then
    cmp -s "$SRC/$s" "$d" || echo "kept $d (edit the limits there; compare with $SRC/$s)"
  else
    install -m "$m" "$SRC/$s" "$d"
  fi
done

# incoming: agents may create files but not list them (-wx for others, sticky); results: world-readable; work: root only.
if [ "$CHECK" = 1 ]; then
  [ "$(stat -c %a $SPOOL/incoming 2>/dev/null)" = "1733" ] || bad "$SPOOL/incoming (mode 1733)"
  [ "$(stat -c %a $SPOOL/results 2>/dev/null)" = "755" ] || bad "$SPOOL/results (mode 755)"
  [ "$(stat -c %a $SPOOL/work 2>/dev/null)" = "700" ] || bad "$SPOOL/work (mode 700)"
  [ -f /etc/pib-provision/board-token ] && [ "$(stat -c %a /etc/pib-provision/board-token)" = "600" ] || bad "/etc/pib-provision/board-token (mode 600, owner root)"
  systemctl is-enabled pib-provision-runner.path >/dev/null 2>&1 || bad "pib-provision-runner.path enabled"
  [ "$FAIL" = 0 ] && echo "provisioning runner: OK"
  exit "$FAIL"
fi

install -d -m 0755 "$SPOOL"
install -d -m 1733 "$SPOOL/incoming"
install -d -m 0755 "$SPOOL/results"
install -d -m 0700 "$SPOOL/work"
chmod 1733 "$SPOOL/incoming"; chmod 0755 "$SPOOL/results"; chmod 0700 "$SPOOL/work"
install -d -m 0700 /etc/pib-provision
[ -f /etc/pib-provision/board-token ] || echo "NOTE: create /etc/pib-provision/board-token (mode 600) holding an instance-admin board token; the runner refuses to start without it."
systemctl daemon-reload
systemctl enable --now pib-provision-runner.path
echo "installed. Check: $0 --check"
