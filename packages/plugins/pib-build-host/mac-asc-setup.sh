#!/usr/bin/env bash
# One-time setup so the Mac Builder can sign and upload over SSH without the login keychain.
#
# Why: over SSH the login keychain is locked, so `asc` ("credentials not found for profile") and code
# signing (errSecInternalComponent) fail. The API key itself is a file (~/private_keys/AuthKey_<id>.p8) and
# `asc` and `xcodebuild` accept the key id, issuer id and file path directly, so nothing has to come
# out of the keychain.
#
# What it does: writes ~/.config/pib/asc.env (mode 600, directory 700) holding the key id, the issuer id
# and the PATH of the .p8 (never its contents) and ASC_BYPASS_KEYCHAIN=1, then checks that `asc` can reach
# App Store Connect with only those variables. It does not touch the keychain, the existing asc profiles
# or the .p8 file, and prints no secret.
#
# Run it on the Mac, in any Terminal (the issuer id is the only thing you type):
#   bash mac-asc-setup.sh                      # asks for the issuer id
#   bash mac-asc-setup.sh --issuer-id <uuid>   # no prompt
#   bash mac-asc-setup.sh --key-id <id> --key-file <path to its .p8>   # another key (default LCM9GBHQLQ, the Velox and Lumen key)
#   bash mac-asc-setup.sh --check              # re-run the checks, change nothing
#   bash mac-asc-setup.sh --app <app id>       # app id to test with (default: Velox 6761457423)
#
# Issuer id: App Store Connect -> Users and Access -> Integrations -> App Store Connect API (top of page).
# It is an identifier, not a secret, but keep it out of chat anyway.
set -euo pipefail

# Never read ASC_KEY_ID / ASC_ISSUER_ID from the calling shell: a Terminal may export another team's key.
KEY_ID="LCM9GBHQLQ"
ISSUER=""
KEYFILE=""
APP_ID="6761457423"
CHECK_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --app) APP_ID="${2:?--app needs an app id}"; shift ;;
    --key-id) KEY_ID="${2:?--key-id needs a key id}"; shift ;;
    --key-file) KEYFILE="${2:?--key-file needs a path to the .p8}"; shift ;;
    --issuer-id) ISSUER="${2:?--issuer-id needs the issuer id}"; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

P8="${KEYFILE:-$HOME/private_keys/AuthKey_${KEY_ID}.p8}"
DIR="$HOME/.config/pib"
ENVFILE="$DIR/asc.env"

[ "$(uname -s)" = Darwin ] || { echo "Run this on the Mac." >&2; exit 1; }
command -v asc >/dev/null || { echo "asc is not installed (/opt/homebrew/bin/asc)." >&2; exit 1; }
if [ ! -f "$P8" ]; then
  echo "Key file not found: $P8" >&2
  echo "Key files on this Mac: $(ls "$HOME"/private_keys/AuthKey_*.p8 2>/dev/null | sed 's#.*/AuthKey_##; s#\.p8##' | tr '\n' ' ')" >&2
  echo "Use --key-id <id> for one of those." >&2; exit 1
fi
mode="$(stat -f '%Lp' "$P8")"
[ "$mode" = 600 ] || { echo "Fixing key file mode ($mode -> 600)."; chmod 600 "$P8"; }

if [ "$CHECK_ONLY" = 0 ]; then
  if [ -z "$ISSUER" ]; then
    printf 'App Store Connect issuer id (UUID): '
    read -r ISSUER
  fi
  echo "$ISSUER" | grep -Eq '^[0-9A-Fa-f]{8}-([0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}$' \
    || { echo "That does not look like an issuer id (a UUID)." >&2; exit 1; }
  mkdir -p "$DIR"; chmod 700 "$DIR"
  umask 077
  cat > "$ENVFILE.new" <<EOF
# Written by mac-asc-setup.sh. Holds identifiers and the PATH of the key file, not the key.
export ASC_KEY_ID="$KEY_ID"
export ASC_ISSUER_ID="$ISSUER"
export ASC_PRIVATE_KEY_PATH="$P8"
export ASC_BYPASS_KEYCHAIN=1
# Same values under the names the xcodebuild flags use in the pib-ios-release skill.
export ASC_KEY_PATH="$P8"
EOF
  chmod 600 "$ENVFILE.new"
  mv "$ENVFILE.new" "$ENVFILE"
  echo "Wrote $ENVFILE (mode 600)."
fi

[ -f "$ENVFILE" ] || { echo "No $ENVFILE yet: run without --check." >&2; exit 1; }

echo "Checking asc with only those variables (keychain bypassed, a clean environment like an SSH run)..."
fail=0
# env -i: nothing inherited from this Terminal, as in a non-interactive SSH session.
if env -i HOME="$HOME" PATH="/opt/homebrew/bin:/usr/bin:/bin" bash -c ". '$ENVFILE'; asc auth status --validate >/dev/null 2>&1"; then
  echo "  OK    asc validates the key against App Store Connect"
else
  echo "  FAIL  asc could not validate the key (wrong issuer id, key id, or the key was revoked)"; fail=1
fi
if env -i HOME="$HOME" PATH="/opt/homebrew/bin:/usr/bin:/bin" bash -c ". '$ENVFILE'; asc builds list --app '$APP_ID' --limit 1 >/dev/null 2>&1"; then
  echo "  OK    asc builds list for app $APP_ID works"
else
  echo "  FAIL  asc builds list for app $APP_ID failed (the key may not have access to this app's team)"; fail=1
fi

# Over SSH to this Mac, if Remote Login lets us in without a prompt.
if ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new "$USER@localhost" true 2>/dev/null; then
  if ssh -o BatchMode=yes "$USER@localhost" ". '$ENVFILE'; asc builds list --app '$APP_ID' --limit 1 >/dev/null 2>&1"; then
    echo "  OK    the same call works over SSH to this Mac"
  else
    echo "  FAIL  works locally but not over SSH (check ~/.zshenv puts /opt/homebrew/bin on PATH)"; fail=1
  fi
else
  echo "  skip  SSH to this Mac without a prompt is not set up; the Mac Builder's next run is the real SSH test"
fi

if [ "$fail" = 0 ]; then
  echo "Done. The Mac Builder reads $ENVFILE (see the pib-ios-release skill). Re-wake it on PAR-1196 and PAR-1466."
else
  echo "Not finished: fix the FAIL lines above and run again (use --check to re-test only)."; exit 1
fi
