# MCP Integration

**Status:** Phase 2 (Active Development)

The MCP (Model Context Protocol) server enables AI assistants to manage the
T-Minus calendar programmatically via natural language commands.

---

## Architecture

The MCP worker (`workers/mcp/`) calls the same Durable Object RPC methods as
the api-worker. It is an alternative entry point to the same canonical store.

The `source` field in the event journal distinguishes MCP-originated changes
from API or provider changes.

---

## Tool Surface

```typescript
// Account management
calendar.list_accounts()
calendar.get_sync_status()

// Event management
calendar.list_events(start, end, account?)
calendar.create_event(event)
calendar.update_event(event_id, patch)
calendar.delete_event(event_id)

// Constraints & trips
calendar.add_trip(name, start, end, timezone, block_policy)
calendar.add_constraint(kind, config)
calendar.list_constraints()

// Availability
calendar.get_availability(start, end, accounts?)

// Scheduling (Phase 3+)
calendar.propose_times(participants, window, duration, constraints, objective?)
calendar.commit_candidate(session_id, candidate_id)

// VIP & policies
calendar.set_vip(participant, priority, conditions)
calendar.set_policy_edge(from_account, to_account, detail_level)

// Time accounting
calendar.tag_billable(event_id, client, category, rate?)
calendar.get_commitment_status(client?)
calendar.export_commitment_proof(client, window)

// Relationships (Phase 4+)
calendar.add_relationship(participant, category, city?, frequency_target?)
calendar.mark_outcome(event_id, outcome, note?)
calendar.get_drift_report()
calendar.get_reconnection_suggestions(trip_id?)

// Overrides
calendar.override(event_id, allow_outside_hours?, reason?)

// Excuse generator (Phase 4+)
calendar.generate_excuse(event_id, tone, truth_level)
```

---

## Authentication

The MCP endpoint uses the same auth layer as the REST API with per-tool
authorization. Requests carry `Authorization: Bearer <token>` and the MCP
worker resolves it to a user_id.

---

## Example Interactions

**Block calendars for a trip:**
> "Block all my calendars for my Berlin trip next week, Monday through Friday."

**Protect deep work time:**
> "Protect 6 hours of deep work next week unless it is an ARR-critical meeting."

**Check commitment compliance:**
> "Am I on track for my 1-day-per-week commitment to Client X?"

**Reconnection suggestions:**
> "I am going to Berlin next week. Who should I try to see?"
