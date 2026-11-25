#!/usr/bin/env bash
# Related-test selection for .github/workflows/pib-core-ci.yml (PAR-14647).
#
#   pib-core-related-tests.sh list
#       Print the test files vitest --changed selects, one per line, minus SKIP_FILES.
#   pib-core-related-tests.sh shard <index> <count>
#       Print shard <index> (1-based) of <count>: the sorted list, every <count>-th file starting at <index>.
#       Round-robin over the sorted paths mixes server, ui and package tests so no shard gets only the heavy ones.
#   pib-core-related-tests.sh has-chat
#       Print "true" when the related list holds the chat integration suite, else "false" (see CHAT_SUITE).
#   pib-core-related-tests.sh run-shard <index> <count>
#       Run that shard and gate on regressions only (PAR-14647). A hub PR selects the whole suite, and the light job
#       does not start every service the suite expects, so some tests are red on the base branch itself. When a
#       test fails here, the same files are re-run on a checkout of origin/<BASE_REF>; only a failure that does NOT
#       also fail there fails the step. A timeout always fails.
#
# Env: BASE_REF (default development), MODE (affected|full; affected limits vitest to the projects whose package
# is in the affected set), RUNNER_TEMP (scratch dir), SHARD_TIMEOUT / BASE_TIMEOUT (run-shard caps, default 40m / 12m),
# RELATED_FILES_OVERRIDE (a file with the list; skips vitest --changed, for local tests of run-shard).
# Diagnostics go to stderr; stdout is only the file list (list, shard).
set -euo pipefail

BASE_REF="${BASE_REF:-development}"
MODE="${MODE:-full}"
TMP_DIR="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"

# Fail on development itself, not caused by a PR. Remove a path once its test is fixed on development.
#   PAR-14632: hermes execute.instructions (3 tests), plugin-scoped-api-routes ('dispatches a board GET route ...')
#   PAR-14647: acpx-engine execute.test.ts ('keeps large continuation history in ACP turns ...'),
#              NewIssueDialog.test.tsx ('carries the source checkout when reusing another worktree ...')
# CLI --exclude is ignored when the root config uses `projects`, and a vitest config edit would rerun every test of
# that project, so the list is filtered here.
SKIP_FILES=(
  'packages/adapters/hermes/src/server/execute.instructions.test.ts'
  'server/src/__tests__/plugin-scoped-api-routes.test.ts'
  'packages/adapter-utils/src/acpx-engine/execute.test.ts'
  'ui/src/components/NewIssueDialog.test.tsx'
)

# One 3.6 MB file (70,000+ lines) that alone outlasts a 30 minute shard (PAR-14647, run 45649825029, shard 6). The
# repo's own PR workflow runs it through `test:run:general --group general-chat`, which splits it by line range, so the
# related-chat job does the same and the generic shards leave it out.
CHAT_SUITE='server/src/__tests__/chat-channels.integration.test.ts'

related_files() {
  if [ -n "${RELATED_FILES_OVERRIDE:-}" ]; then sort -u "$RELATED_FILES_OVERRIDE"; return; fi
  local projects=() name list_json
  if [ "$MODE" = "affected" ]; then
    while IFS= read -r name; do
      [ -n "$name" ] && projects+=(--project "$name")
    done < <(pnpm --filter "...[origin/${BASE_REF}]" list --json --depth -1 | jq -r '.[].name')
  fi
  list_json="${TMP_DIR}/related-test-files.json"
  # No `|| true` on vitest: a config error (PAR-12762) must fail the step, not read as "no tests".
  pnpm exec vitest list --filesOnly --json="$list_json" --changed "origin/${BASE_REF}" "${projects[@]}" >/dev/null
  local skip_args=()
  for f in "${SKIP_FILES[@]}"; do skip_args+=(-e "$f"); done
  jq -r --arg root "$PWD/" '.[].file | ltrimstr($root)' "$list_json" | sort -u | grep -vxF "${skip_args[@]}" || true
}

# Failed tests of a vitest --reporter=json file as "file::full test name" lines (a file that failed to load: "file::").
failed_keys() {
  jq -r --arg root "$PWD/" '.testResults[]
    | (.name | ltrimstr($root)) as $f
    | select(.status == "failed")
    | ([.assertionResults[]? | select(.status == "failed") | $f + "::" + .fullName]
       | if length == 0 then [$f + "::"] else . end)[]' "$1" | sort -u
}

run_shard() {
  local index="$1" count="$2" files=() rc=0 out
  out="${TMP_DIR}/shard-${index}.json"
  mapfile -t files < <("$0" shard "$index" "$count")
  if [ "${#files[@]}" -eq 0 ]; then echo "no related test files in this shard"; return 0; fi
  echo "shard ${index}/${count}: ${#files[@]} test files"
  printf 'related test file: %s\n' "${files[@]}"
  timeout "${SHARD_TIMEOUT:-40m}" pnpm exec vitest run "${files[@]}" --reporter=default --reporter=json --outputFile.json="$out" || rc=$?
  if [ "$rc" -eq 0 ]; then return 0; fi
  if [ "$rc" -eq 124 ] || [ ! -s "$out" ]; then
    echo "::error::Shard ${index} hit its time limit or produced no result (exit ${rc}). This is a failure, not a pass."
    return "$rc"
  fi
  failed_keys "$out" > "${TMP_DIR}/pr-failed.txt"
  echo "::group::${index}: $(wc -l < "${TMP_DIR}/pr-failed.txt") failing tests in this shard; re-running their files on origin/${BASE_REF}"
  # Re-run only the failing files that exist on the base (a file the PR adds cannot have failed there).
  local base_dir="${TMP_DIR}/base-checkout" base_files=()
  git worktree add --detach "$base_dir" "origin/${BASE_REF}" >/dev/null
  while IFS= read -r f; do
    if [ -f "${base_dir}/${f}" ]; then base_files+=("$f"); fi
  done < <(cut -d: -f1 "${TMP_DIR}/pr-failed.txt" | sort -u)
  : > "${TMP_DIR}/base-failed.txt"
  if [ "${#base_files[@]}" -gt 0 ]; then
    (
      cd "$base_dir"
      pnpm install --frozen-lockfile --prefer-offline >/dev/null
      pnpm --filter '@paperclipai/paperclip-runner' build:typescript >/dev/null
      pnpm --filter @paperclipai/plugin-sdk ensure-build-deps >/dev/null
      timeout "${BASE_TIMEOUT:-12m}" pnpm exec vitest run "${base_files[@]}" --reporter=json --outputFile.json="${TMP_DIR}/base.json" >/dev/null 2>&1 || true
      if [ -s "${TMP_DIR}/base.json" ]; then failed_keys "${TMP_DIR}/base.json" > "${TMP_DIR}/base-failed.txt"; fi
    )
  fi
  echo "::endgroup::"
  # Keep only failures the base does not have: same test (or same file, when it failed to load).
  comm -23 "${TMP_DIR}/pr-failed.txt" "${TMP_DIR}/base-failed.txt" > "${TMP_DIR}/new-failed.txt"
  local same new
  same="$(comm -12 "${TMP_DIR}/pr-failed.txt" "${TMP_DIR}/base-failed.txt" | wc -l)"
  new="$(wc -l < "${TMP_DIR}/new-failed.txt")"
  echo "failing here and on origin/${BASE_REF} too (not caused by this PR): ${same}"
  if [ "$same" -gt 0 ]; then comm -12 "${TMP_DIR}/pr-failed.txt" "${TMP_DIR}/base-failed.txt" | sed 's/^/  pre-existing: /'; fi
  if [ "$new" -gt 0 ]; then
    echo "::error::${new} test(s) fail with this PR and pass on origin/${BASE_REF}:"
    sed 's/^/  NEW FAILURE: /' "${TMP_DIR}/new-failed.txt"
    return 1
  fi
  echo "no failure is new in this PR"
}

case "${1:-}" in
  list)
    related_files
    ;;
  shard)
    index="${2:?shard index (1-based)}"
    count="${3:?shard count}"
    related_files | grep -vxF -e "$CHAT_SUITE" | awk -v i="$index" -v n="$count" '(NR - 1) % n == i - 1' || true
    ;;
  has-chat)
    # grep -c, not -q: -q exits early and pipefail would then fail the pipeline on the writer's SIGPIPE.
    if [ "$(related_files | grep -cxF -e "$CHAT_SUITE" || true)" -gt 0 ]; then echo true; else echo false; fi
    ;;
  run-shard)
    run_shard "${2:?shard index (1-based)}" "${3:?shard count}"
    ;;
  *)
    echo "usage: $0 list | shard <index> <count> | has-chat | run-shard <index> <count>" >&2
    exit 2
    ;;
esac
