# Correctness Invariants

These five invariants are non-negotiable. Violating any of them produces sync
loops, data corruption, or privacy breaches. Every code review must verify
these hold.

---

## Invariant A: Every Provider Event is Classified

When processing a provider event E, it is exactly one of:

- **origin**: user-authored in that provider, not managed by us
- **managed mirror**: created by us (tagged with extended properties)
- **foreign managed**: created by another system; treat as origin

Classification uses Google Calendar `extendedProperties.private`:

```json
{
  "extendedProperties": {
    "private": {
      "tminus": "true",
      "managed": "true",
      "canonical_event_id": "evt_...",
      "origin_account_id": "acc_..."
    }
  }
}
```

If `tminus == "true"` AND `managed == "true"`, the event is a managed mirror.
All other events are treated as origin events.

---

## Invariant B: Canonical Event ID is Stable

We generate `canonical_event_id` (ULID) at creation time. It never changes.
All mirrors reference it. The mapping is: one canonical -> N mirrors.

The ULID is generated once, stored in `canonical_events.canonical_event_id`,
and propagated to mirrors via `extendedProperties.private.canonical_event_id`.
No operation may change a canonical event's ID after initial creation.

---

## Invariant C: Projections are Deterministic

Given a canonical event + policy profile (A -> B) + target calendar kind,
the projected payload is always the same. We use stable hashing to determine
"do we need to PATCH?"

```
projected_hash = SHA-256(
  canonical_event_id +
  detail_level +
  calendar_kind +
  sorted(relevant_fields_by_detail_level)
)
```

If `projected_hash == event_mirrors.last_projected_hash`, skip the write.
This is the primary lever for both correctness and API quota conservation.

---

## Invariant D: Idempotency Everywhere

Every external write job includes:

- `idempotency_key`: `hash(canonical_event_id + target_account_id + projected_hash)`
- Expected state checks before mutation (existing `provider_event_id`, etc.)

Retries must not duplicate or thrash. The write-consumer checks current mirror
state before executing any Calendar API call.

---

## Invariant E: Managed Events are Never Treated as Origin

If a webhook fires for an event with `tminus_managed = "true"`, we do NOT
propagate it as a new origin change. We only check if it drifted from our
expected state and correct if needed.

This invariant prevents sync loops. Without it, a mirror update in Account B
would trigger a webhook, which would be treated as a new origin event, which
would project back to Account A, creating an infinite cycle.
