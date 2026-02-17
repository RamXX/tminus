# CalDAV Integration

**Status:** Planned for Phase 5

CalDAV (Calendaring Extensions to WebDAV) support is planned in two forms:

---

## Read-Only CalDAV Feed (Outbound)

T-Minus will expose the unified calendar as a read-only CalDAV feed. This allows
native calendar apps (Apple Calendar, Thunderbird, etc.) to subscribe to the
unified view without using the T-Minus web UI.

### Use Case

Users who prefer their native calendar app can add a CalDAV subscription URL that
shows all events across all connected accounts in a single feed.

### Design Considerations

- Read-only (no writes through CalDAV -- use the REST API or MCP for mutations)
- Per-user feed URL with authentication token
- VTIMEZONE and VEVENT generation from canonical events
- Refresh interval configurable per subscription

---

## CalDAV Client (Inbound -- Apple Calendar)

T-Minus will also act as a CalDAV client to sync from Apple Calendar (iCloud).
This enables Apple Calendar as a provider alongside Google and Microsoft.

### Differences from REST-based Providers

- No push notifications -- must poll for changes
- CalDAV uses XML (PROPFIND/REPORT), not JSON
- Authentication via app-specific passwords, not OAuth
- Change detection via `ctag` (collection tag) and `etag` (entity tag)
