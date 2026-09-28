#!/usr/bin/env bash
# Mac build host for Paperclip: checks this Mac can be an `ssh` environment
# (reached over Tailscale) for iOS builds, and prints the values to enter in
# Paperclip → Company settings → Environments.
#
#   bash mac-build-host.sh                 # check only, changes nothing
#   bash mac-build-host.sh --setup         # also: workspace folder, PATH for SSH sessions, Paperclip SSH key
#   bash mac-build-host.sh --setup --workspace ~/paperclip-builds
#
# It never changes system settings. Remote Login, Tailscale login and sleep
# settings are yours to switch; the script says exactly where.
set -uo pipefail

SETUP=0
WORKSPACE="$HOME/paperclip-builds"
KEY="$HOME/.ssh/paperclip_env_ed25519"
while [ $# -gt 0 ]; do
  case "$1" in
    --setup) SETUP=1 ;;
    --workspace) WORKSPACE="${2:?--workspace needs a folder}"; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
WORKSPACE="${WORKSPACE/#\~/$HOME}"

ok=0; todo=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; ok=$((ok + 1)); }
need() { printf '  \033[33m•\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '      %s\n' "$2"; todo=$((todo + 1)); }
head1() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# What a non-interactive SSH session sees (zsh reads only ~/.zshenv there).
ssh_shell() { env -i HOME="$HOME" USER="$USER" /bin/zsh -c "$1" 2>/dev/null; }

[ "$(uname -s)" = "Darwin" ] || { echo "This script is for macOS." >&2; exit 1; }

head1 "Build tools"
if xcode-select -p >/dev/null 2>&1 && xcodebuild -version >/dev/null 2>&1; then
  pass "Xcode: $(xcodebuild -version | head -1) at $(xcode-select -p)"
else
  need "Xcode is not ready" "Install Xcode, open it once, then: sudo xcode-select -s /Applications/Xcode.app"
fi
if command -v asc >/dev/null 2>&1; then
  pass "asc CLI: $(asc --version 2>/dev/null | head -1)"
  profiles="$(asc auth status 2>/dev/null | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin); print(", ".join(c["name"]+(" (default)" if c.get("isDefault") else "") for c in d.get("credentials",[])))
except Exception: pass' 2>/dev/null)"
  if [ -n "$profiles" ]; then pass "App Store Connect key profiles: $profiles"; else need "No asc key profile" "asc auth login --name <team> (one API key per App Store Connect team)"; fi
else
  need "asc CLI missing" "brew install asc (App Store Connect CLI)"
fi

head1 "What an SSH session finds (non-interactive zsh reads ~/.zshenv only)"
for tool in claude git node xcodebuild asc; do
  found="$(ssh_shell "source ~/.zshenv >/dev/null 2>&1; command -v $tool")"
  if [ -n "$found" ]; then pass "$tool → $found"; else
    need "$tool is not on the PATH of SSH sessions" "Add to ~/.zshenv: export PATH=\"/opt/homebrew/bin:/usr/local/bin:\$HOME/.local/bin:\$PATH\" (--setup does this)"
  fi
done
if command -v claude >/dev/null 2>&1; then
  pass "claude CLI: $(claude --version 2>/dev/null | head -1) (log it in once in Terminal: claude)"
else
  need "claude CLI missing" "npm install -g @anthropic-ai/claude-code, then run claude once to log in"
fi

head1 "Reachable from the Paperclip server"
TS=""
for candidate in tailscale /Applications/Tailscale.app/Contents/MacOS/Tailscale; do
  if command -v "$candidate" >/dev/null 2>&1 || [ -x "$candidate" ]; then TS="$candidate"; break; fi
done
TS_HOST=""; TS_IP=""
if [ -n "$TS" ]; then
  TS_IP="$("$TS" ip -4 2>/dev/null | head -1)"
  TS_HOST="$("$TS" status --json 2>/dev/null | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))
except Exception: pass' 2>/dev/null)"
  if [ -n "$TS_IP" ]; then pass "Tailscale up: ${TS_HOST:-?} ($TS_IP)"; else need "Tailscale is installed but not logged in" "Open Tailscale and log in with the same account as the server"; fi
else
  need "Tailscale is not installed" "Install from https://tailscale.com/download/mac and log in (the server joins the same tailnet)"
fi
if nc -z -G 2 127.0.0.1 22 >/dev/null 2>&1; then
  pass "Remote Login (SSH) is on"
else
  need "Remote Login (SSH) is off" "System Settings → General → Sharing → Remote Login: on, allow access for $USER only"
fi

head1 "Stays awake for runs"
sleep_min="$(pmset -g 2>/dev/null | awk '/^ *sleep /{print $2; exit}')"
if [ "${sleep_min:-1}" = "0" ]; then pass "System sleep is off"; else
  need "The Mac sleeps after ${sleep_min:-?} min: runs fail while it sleeps" "System Settings → Energy (or Battery → Options): prevent automatic sleeping when the display is off, and wake for network access"
fi

head1 "Workspace and Paperclip key"
if [ -d "$WORKSPACE" ]; then pass "Workspace folder $WORKSPACE"; else
  if [ $SETUP = 1 ]; then mkdir -p "$WORKSPACE" && pass "Created $WORKSPACE"; else need "No workspace folder yet" "--setup creates $WORKSPACE"; fi
fi
if [ $SETUP = 1 ]; then
  if ! grep -q "paperclip-build-host PATH" "$HOME/.zshenv" 2>/dev/null; then
    printf '\n# paperclip-build-host PATH: tools for non-interactive SSH sessions\nexport PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"\n' >> "$HOME/.zshenv"
    pass "Added the tool PATH to ~/.zshenv"
  fi
  mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
  if [ ! -f "$KEY" ]; then
    ssh-keygen -q -t ed25519 -N "" -C "paperclip-env@$(hostname -s)" -f "$KEY" && pass "Made the Paperclip SSH key $KEY"
  fi
  touch "$HOME/.ssh/authorized_keys" && chmod 600 "$HOME/.ssh/authorized_keys"
  if ! grep -qF "$(cut -d' ' -f2 "$KEY.pub")" "$HOME/.ssh/authorized_keys"; then
    cat "$KEY.pub" >> "$HOME/.ssh/authorized_keys" && pass "Allowed the Paperclip key to log in as $USER"
  fi
fi
if [ -f "$KEY" ]; then pass "Paperclip SSH key exists ($KEY)"; else need "No Paperclip SSH key yet" "--setup makes one and allows it in ~/.ssh/authorized_keys"; fi

head1 "Paperclip environment values (Company settings → Environments → New → SSH)"
HOST="${TS_HOST:-${TS_IP:-<tailscale name or 100.x address>}}"
printf '  Name                   %s\n' "Mac build host ($(hostname -s))"
printf '  Host                   %s\n' "$HOST"
printf '  Port                   22\n'
printf '  Username               %s\n' "$USER"
printf '  Remote workspace path  %s\n' "$WORKSPACE"
printf '  Private key            company secret with the contents of %s\n' "$KEY"
printf '                         (pbcopy < %s, paste as a new secret, then run: rm %s)\n' "$KEY" "$KEY"
if nc -z -G 2 127.0.0.1 22 >/dev/null 2>&1; then
  printf '  Known hosts            %s\n' "$(ssh-keyscan -t ed25519 127.0.0.1 2>/dev/null | grep -v "^#" | sed "s/^127.0.0.1/$HOST/" | head -1)"
fi

printf '\n%d ok, %d to do.\n' "$ok" "$todo"
[ "$todo" -eq 0 ]
