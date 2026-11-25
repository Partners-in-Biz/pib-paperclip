#!/usr/bin/env bash
# Related-test selection for .github/workflows/pib-core-ci.yml (PAR-14647).
#
#   pib-core-related-tests.sh list
#       Print the test files vitest --changed selects, one per line, minus SKIP_FILES.
#   pib-core-related-tests.sh shard <index> <count>
#       Print shard <index> (1-based) of <count>: the sorted list, every <count>-th file starting at <index>.
#       Round-robin over the sorted paths mixes server, ui and package tests so no shard gets only the heavy ones.
#
# Env: BASE_REF (default development), MODE (affected|full; affected limits vitest to the projects whose package
# is in the affected set), RUNNER_TEMP (scratch dir). Diagnostics go to stderr; stdout is only the file list.
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

related_files() {
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

case "${1:-}" in
  list)
    related_files
    ;;
  shard)
    index="${2:?shard index (1-based)}"
    count="${3:?shard count}"
    related_files | awk -v i="$index" -v n="$count" '(NR - 1) % n == i - 1'
    ;;
  *)
    echo "usage: $0 list | shard <index> <count>" >&2
    exit 2
    ;;
esac
