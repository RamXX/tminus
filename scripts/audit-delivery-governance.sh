#!/usr/bin/env bash
# audit-delivery-governance.sh
#
# Audits closed beads issues for delivery-governance label/contract integrity.
# Identifies issues where closure status is inconsistent with Paivot workflow
# requirements (delivered/accepted/rejected label lifecycle).
#
# Exit codes:
#   0 - No mismatches found
#   1 - Mismatches found (report printed to stdout)
#   2 - Error (bd command failed, jq missing, etc.)
#
# Usage:
#   ./scripts/audit-delivery-governance.sh          # human-readable report
#   ./scripts/audit-delivery-governance.sh --json    # machine-readable JSON
#   ./scripts/audit-delivery-governance.sh --counts  # summary counts only

set -euo pipefail

# ---- Dependency check ----
for cmd in bd jq; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: Required command '$cmd' not found in PATH." >&2
    exit 2
  fi
done

MODE="${1:-report}"

# ---- Fetch closed issues ----
CLOSED_JSON=$(bd list --status=closed --json 2>/dev/null) || {
  echo "ERROR: 'bd list --status=closed --json' failed." >&2
  exit 2
}

TOTAL_CLOSED=$(echo "$CLOSED_JSON" | jq 'length')

# ---- Classify each issue ----
# Category A: closed + delivered, no accepted/rejected  (MISMATCH)
# Category B: closed + accepted                         (OK)
# Category C: closed + rejected (with reason)           (OK if reason present)
# Category D: closed, no delivery labels at all         (NEEDS REVIEW)

CAT_A=$(echo "$CLOSED_JSON" | jq '[.[] | select(
  (.labels // [] | index("delivered")) and
  ((.labels // [] | index("accepted")) | not) and
  ((.labels // [] | index("rejected")) | not)
)]')

CAT_B=$(echo "$CLOSED_JSON" | jq '[.[] | select(
  (.labels // [] | index("accepted"))
)]')

CAT_C=$(echo "$CLOSED_JSON" | jq '[.[] | select(
  (.labels // [] | index("rejected"))
)]')

CAT_D=$(echo "$CLOSED_JSON" | jq '[.[] | select(
  ((.labels // [] | index("delivered")) | not) and
  ((.labels // [] | index("accepted")) | not) and
  ((.labels // [] | index("rejected")) | not)
)]')

COUNT_A=$(echo "$CAT_A" | jq 'length')
COUNT_B=$(echo "$CAT_B" | jq 'length')
COUNT_C=$(echo "$CAT_C" | jq 'length')
COUNT_D=$(echo "$CAT_D" | jq 'length')
COUNT_MISMATCH=$((COUNT_A + COUNT_D))

# ---- Output ----
if [ "$MODE" = "--json" ]; then
  jq -n \
    --argjson total "$TOTAL_CLOSED" \
    --argjson mismatch_count "$COUNT_MISMATCH" \
    --argjson delivered_no_accepted_count "$COUNT_A" \
    --argjson accepted_count "$COUNT_B" \
    --argjson rejected_count "$COUNT_C" \
    --argjson no_labels_count "$COUNT_D" \
    --argjson delivered_no_accepted "$CAT_A" \
    --argjson no_labels "$CAT_D" \
    '{
      total_closed: $total,
      mismatch_count: $mismatch_count,
      categories: {
        delivered_no_accepted: { count: $delivered_no_accepted_count, issues: ($delivered_no_accepted | [.[] | {id, title, labels, issue_type}]) },
        accepted: { count: $accepted_count },
        rejected: { count: $rejected_count },
        no_delivery_labels: { count: $no_labels_count, issues: ($no_labels | [.[] | {id, title, labels, issue_type}]) }
      }
    }'
elif [ "$MODE" = "--counts" ]; then
  echo "Delivery Governance Audit Summary"
  echo "================================="
  echo "Total closed issues:              $TOTAL_CLOSED"
  echo "  Accepted (OK):                  $COUNT_B"
  echo "  Rejected (OK if reason):        $COUNT_C"
  echo "  Delivered w/o accepted (FIX):   $COUNT_A"
  echo "  No delivery labels (REVIEW):    $COUNT_D"
  echo "  ---------------------------------"
  echo "  Total mismatches:               $COUNT_MISMATCH"
else
  echo "=============================================="
  echo "  Delivery Governance Audit Report"
  echo "  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "=============================================="
  echo ""
  echo "Total closed issues: $TOTAL_CLOSED"
  echo ""
  echo "--- Category Breakdown ---"
  echo "  Accepted (OK):                  $COUNT_B"
  echo "  Rejected (OK if reason):        $COUNT_C"
  echo "  Delivered w/o accepted (FIX):   $COUNT_A"
  echo "  No delivery labels (REVIEW):    $COUNT_D"
  echo ""
  echo "Total mismatches: $COUNT_MISMATCH"
  echo ""

  if [ "$COUNT_A" -gt 0 ]; then
    echo "--- MISMATCH: Closed + Delivered, No Acceptance Resolution ---"
    echo "$CAT_A" | jq -r '.[] | "  \(.id): \(.title) [labels: \(.labels // [] | join(", "))]"'
    echo ""
  fi

  if [ "$COUNT_D" -gt 0 ]; then
    echo "--- NEEDS REVIEW: Closed, No Delivery Labels ---"
    echo "$CAT_D" | jq -r '.[] | "  \(.id) (\(.issue_type)): \(.title) [labels: \(.labels // [] | join(", "))]"'
    echo ""
  fi
fi

# Exit 1 if mismatches found, 0 if clean
if [ "$COUNT_MISMATCH" -gt 0 ]; then
  exit 1
else
  if [ "$MODE" != "--json" ]; then
    echo "All closed issues have proper delivery governance labels."
  fi
  exit 0
fi
