#!/usr/bin/env bash
set -euo pipefail

violations="$(
  find .github/workflows -type f \( -name '*.yml' -o -name '*.yaml' \) -print0 |
    xargs -0 awk '
      /^[[:space:]-]*uses:[[:space:]]*/ {
        action = $0
        sub(/^[[:space:]-]*uses:[[:space:]]*/, "", action)
        sub(/[[:space:]]+#.*$/, "", action)

        if (action ~ /^\.\//) {
          next
        }

        at = index(action, "@")
        ref = at ? substr(action, at + 1) : ""
        if (!at || length(ref) != 40 || ref !~ /^[0-9a-fA-F]+$/) {
          print FILENAME ":" FNR ": " action
        }
      }
    '
)"

if [[ -n "$violations" ]]; then
  printf 'Unpinned GitHub Actions found:\n%s\n' "$violations" >&2
  exit 1
fi

echo "All third-party GitHub Actions are pinned to 40-character commit SHAs."
