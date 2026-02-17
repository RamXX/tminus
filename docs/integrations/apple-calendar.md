# Apple Calendar Integration

**Status:** Planned for Phase 5

Apple Calendar support will be provided via CalDAV protocol integration, not a proprietary API.

---

## Planned Approach

Apple Calendar (iCloud Calendar) exposes a CalDAV interface. T-Minus will integrate as a CalDAV client to:

1. Read events from Apple Calendar accounts
2. Write busy overlay events back

See [CalDAV](caldav.md) for protocol-level details.

## Challenges

- Apple CalDAV requires app-specific passwords for authentication
- No push notification mechanism (polling required)
- CalDAV protocol is more complex than Google/Microsoft REST APIs
