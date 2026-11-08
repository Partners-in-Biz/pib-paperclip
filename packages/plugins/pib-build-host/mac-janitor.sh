#!/bin/bash
# Mac build host janitor. Keeps the Mac Builder's machine from filling up and slowing down.
#
# Why: Paperclip copies the whole project worktree (with node_modules) to the Mac for every run
# (~800 MB each) and never removes the copy; Xcode DerivedData, simulators and emulators pile up too.
# Agents are told to clean up after themselves (pib-ios-release skill, "Clean up when done"), but an
# agent can crash or forget, so this job is the safety net. It runs hourly from launchd.
#
#   mac-janitor.sh            do it
#   mac-janitor.sh --dry-run  print what it would do, change nothing
#
# Rules (every path is checked to sit under the paths below before anything is removed):
#   1. Run copies  ~/paperclip-builds/.paperclip-runtime/runs/<id>
#        - in use (a process has its cwd there, or its id is in a command line): never touched
#        - idle for RUN_STRIP_HOURS: node_modules, Pods, build dirs and .gradle are removed
#        - idle for RUN_DELETE_HOURS: the whole copy is removed (the host synced it back when the run ended)
#   2. Xcode DerivedData: ~/paperclip-builds/**/dd-* and Xcode's own DerivedData, untouched for DD_DAYS days
#   3. Simulators and emulators: when no run is active and no build is running, shut down every booted
#        iOS simulator and stop Android emulators
#   4. Orphans: processes re-parented to launchd whose working directory is a run copy, older than 1 hour
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

BASE="$HOME/paperclip-builds"
RUNS="$BASE/.paperclip-runtime/runs"
LOG="$BASE/logs/mac-janitor.log"
RUN_STRIP_HOURS="${RUN_STRIP_HOURS:-2}"
RUN_DELETE_HOURS="${RUN_DELETE_HOURS:-12}"
DD_DAYS="${DD_DAYS:-2}"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

mkdir -p "$BASE/logs"
say() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" | tee -a "$LOG"; }
kb()  { du -sk "$1" 2>/dev/null | cut -f1; }
FREED_KB=0

remove() {  # remove <path>: refuses anything outside the allowed roots
  local p="$1"
  case "$p" in
    "$RUNS"/*|"$BASE"/dd-*|"$BASE"/*/dd-*|"$HOME/Library/Developer/Xcode/DerivedData"/*) ;;
    *) say "REFUSED to remove $p (outside allowed paths)"; return 1 ;;
  esac
  [ -e "$p" ] || return 0
  local k; k=$(kb "$p"); k=${k:-0}
  if [ "$DRY" = 1 ]; then say "would remove $p ($((k/1024)) MB)"; else rm -rf "$p"; say "removed $p ($((k/1024)) MB)"; fi
  FREED_KB=$((FREED_KB + k))
}

# ---- what is in use right now -------------------------------------------------------------
CWDS=$(lsof -w -a -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
CMDS=$(ps -axo command= 2>/dev/null)
in_use() {  # in_use <dir>: a process lives in it or names it
  local d="$1" id; id=$(basename "$d")
  echo "$CWDS" | grep -qF "$d/" && return 0
  echo "$CWDS" | grep -qxF "$d" && return 0
  echo "$CMDS" | grep -qF "$id" && return 0
  return 1
}
newest_age_hours() {  # hours since anything in the run copy (not inside node_modules) changed
  local d="$1" newest now
  newest=$(find "$d" -path '*/node_modules' -prune -o -path '*/.git' -prune -o -type f -print0 2>/dev/null \
           | xargs -0 stat -f %m 2>/dev/null | sort -rn | head -1)
  [ -z "$newest" ] && newest=$(stat -f %m "$d")
  now=$(date +%s); echo $(( (now - newest) / 3600 ))
}

ACTIVE_RUNS=0
if [ -d "$RUNS" ]; then
  for d in "$RUNS"/*/; do
    d="${d%/}"; [ -d "$d" ] || continue
    if in_use "$d"; then ACTIVE_RUNS=$((ACTIVE_RUNS+1)); continue; fi
    age=$(newest_age_hours "$d")
    if [ "$age" -ge "$RUN_DELETE_HOURS" ]; then
      remove "$d"
    elif [ "$age" -ge "$RUN_STRIP_HOURS" ]; then
      while IFS= read -r x; do remove "$x"; done < <(
        find "$d" -maxdepth 6 \( -name node_modules -o -name Pods -o -name .gradle -o -name DerivedData \) -type d -prune -print 2>/dev/null
        find "$d" -maxdepth 4 -path '*/android/build' -o -maxdepth 4 -path '*/android/app/build' -o -maxdepth 4 -path '*/ios/build' 2>/dev/null | while read -r b; do [ -d "$b" ] && echo "$b"; done
      )
    fi
  done
fi

# ---- DerivedData -------------------------------------------------------------------------
BUILDING=0
echo "$CMDS" | grep -qE 'xcodebuild|xcrun .*(xcodebuild|simctl (install|launch))|gradlew|gradle-wrapper' && BUILDING=1
if [ "$BUILDING" = 0 ]; then
  for d in "$BASE"/dd-* "$BASE"/*/dd-* "$HOME/Library/Developer/Xcode/DerivedData"/*; do
    [ -d "$d" ] || continue
    [ -n "$(find "$d" -maxdepth 1 -mtime -"$DD_DAYS" -print -quit 2>/dev/null)" ] && continue
    [ -n "$(find "$d" -maxdepth 3 -mtime -"$DD_DAYS" -print -quit 2>/dev/null)" ] && continue
    remove "$d"
  done
fi

# ---- simulators and emulators --------------------------------------------------------------
if [ "$ACTIVE_RUNS" = 0 ] && [ "$BUILDING" = 0 ]; then
  if xcrun simctl list devices booted 2>/dev/null | grep -q "(Booted)"; then
    if [ "$DRY" = 1 ]; then say "would shut down booted iOS simulators"; else xcrun simctl shutdown all >/dev/null 2>&1; say "shut down booted iOS simulators"; fi
  fi
  if pgrep -qf "qemu-system|emulator64|/emulator/emulator"; then
    if [ "$DRY" = 1 ]; then say "would stop Android emulators"; else
      command -v adb >/dev/null && adb devices 2>/dev/null | awk '/^emulator-/{print $1}' | while read -r e; do adb -s "$e" emu kill >/dev/null 2>&1; done
      sleep 3; pkill -f "qemu-system|emulator64" >/dev/null 2>&1; say "stopped Android emulators"
    fi
  fi
fi

# ---- orphans of finished runs -----------------------------------------------------------------
ps -axo pid=,ppid=,etime=,comm= 2>/dev/null | awk '$2==1 && $3 ~ /:/ {print $1, $3}' | while read -r pid et; do
  case "$et" in *-*|[0-9][0-9]:[0-9][0-9]:[0-9][0-9]) ;; *) continue ;; esac   # older than 1 hour only
  cwd=$(lsof -w -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
  case "$cwd" in
    "$RUNS"/*)
      id=$(echo "${cwd#$RUNS/}" | cut -d/ -f1)
      in_use "$RUNS/$id" && ! echo "$CWDS" | grep -qxF "$cwd" && continue
      if [ "$DRY" = 1 ]; then say "would kill orphan pid $pid in $cwd"; else kill "$pid" 2>/dev/null; say "killed orphan pid $pid in $cwd"; fi ;;
  esac
done

FREE=$(df -h / | awk 'NR==2{print $4}')
say "done: freed ~$((FREED_KB/1024)) MB, active runs $ACTIVE_RUNS, disk free $FREE$([ "$DRY" = 1 ] && echo ' (dry run)')"
