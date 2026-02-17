#!/usr/bin/env bash
# verify-closure-governance.sh
#
# Pre-closure verification hook. Checks whether a beads issue has the required
# delivery governance labels before it can be closed cleanly.
#
# Intended to be run before `bd close <id>` or integrated into a make target.
#
# Usage:
#   ./scripts/verify-closure-governance.sh <issue-id>
#
# Exit codes:
#   0 - Issue is ready to close (has accepted or rejected label with reason)
#   1 - Issue is NOT ready to close (missing governance labels)
#   2 - Error (bad arguments, bd command failure)

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <issue-id>" >&2
  exit 2
fi

ISSUE_ID="$1"

for cmd in bd jq; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: Required command '$cmd' not found in PATH." >&2
    exit 2
  fi
done

ISSUE_JSON=$(bd show "$ISSUE_ID" --json 2>/dev/null) || {
  echo "ERROR: Could not fetch issue '$ISSUE_ID'." >&2
  exit 2
}

# bd show returns an array; extract the first element
ISSUE=$(echo "$ISSUE_JSON" | jq '.[0] // empty')
if [ -z "$ISSUE" ]; then
  echo "ERROR: Issue '$ISSUE_ID' not found." >&2
  exit 2
fi

TITLE=$(echo "$ISSUE" | jq -r '.title')
STATUS=$(echo "$ISSUE" | jq -r '.status')
LABELS=$(echo "$ISSUE" | jq -r '.labels // []')
ISSUE_TYPE=$(echo "$ISSUE" | jq -r '.issue_type')
NOTES=$(echo "$ISSUE" | jq -r '.notes // ""')

HAS_ACCEPTED=$(echo "$LABELS" | jq 'index("accepted") != null')
HAS_REJECTED=$(echo "$LABELS" | jq 'index("rejected") != null')
HAS_DELIVERED=$(echo "$LABELS" | jq 'index("delivered") != null')

echo "Issue: $ISSUE_ID - $TITLE"
echo "Type: $ISSUE_TYPE | Status: $STATUS"
echo ""

ERRORS=()

# Rule 1: Must have accepted or rejected label
if [ "$HAS_ACCEPTED" = "false" ] && [ "$HAS_REJECTED" = "false" ]; then
  ERRORS+=("Missing 'accepted' or 'rejected' label. Issues must be accepted or rejected before closure.")
fi

# Rule 2: If rejected, must have rejection reason in notes
if [ "$HAS_REJECTED" = "true" ]; then
  if ! echo "$NOTES" | grep -qi "reject"; then
    ERRORS+=("Has 'rejected' label but no rejection reason found in notes.")
  fi
fi

# Rule 3: Non-epic/non-manual tasks should have delivered label
if [ "$ISSUE_TYPE" = "task" ] || [ "$ISSUE_TYPE" = "bug" ] || [ "$ISSUE_TYPE" = "story" ]; then
  MANUAL=$(echo "$TITLE" | grep -ci "\[MANUAL\]" || true)
  if [ "$MANUAL" -eq 0 ] && [ "$HAS_DELIVERED" = "false" ]; then
    ERRORS+=("Task/story/bug is missing 'delivered' label. Non-manual issues must be delivered before acceptance.")
  fi
fi

# Rule 4: Accepted non-manual tasks should have delivery evidence in notes
if [ "$HAS_ACCEPTED" = "true" ] && [ "$ISSUE_TYPE" != "epic" ]; then
  MANUAL=$(echo "$TITLE" | grep -ci "\[MANUAL\]" || true)
  if [ "$MANUAL" -eq 0 ]; then
    HAS_EVIDENCE=$(echo "$NOTES" | grep -ci "DELIVERED\|CI Results\|bd_contract\|PASS\|ACCEPTANCE" || true)
    if [ "$HAS_EVIDENCE" -eq 0 ]; then
      ERRORS+=("Has 'accepted' label but no delivery evidence found in notes (expected DELIVERED, CI Results, or bd_contract keywords).")
    fi
  fi
fi

if [ ${#ERRORS[@]} -gt 0 ]; then
  echo "GOVERNANCE CHECK: FAILED"
  echo ""
  for err in "${ERRORS[@]}"; do
    echo "  [X] $err"
  done
  echo ""
  echo "Fix the above issues before closing this issue."
  exit 1
else
  echo "GOVERNANCE CHECK: PASSED"
  echo "  [OK] Has acceptance/rejection resolution"
  if [ "$HAS_DELIVERED" = "true" ]; then
    echo "  [OK] Has delivered label"
  fi
  echo ""
  echo "Issue $ISSUE_ID is ready to close."
  exit 0
fi
