# T-Minus Documentation

Welcome to the T-Minus documentation. This is the central hub for all project
documentation organized by audience and topic.

---

## For Developers

Getting started building on or contributing to T-Minus.

- [Getting Started](development/getting-started.md) -- Environment setup and first build
- [Project Structure](development/project-structure.md) -- Monorepo layout and conventions
- [Testing Guide](development/testing.md) -- Unit, integration, and E2E testing
- [Coding Conventions](development/coding-conventions.md) -- TypeScript style and patterns
- [Adding Workers](development/adding-workers.md) -- How to add a new Worker service
- [Adding Endpoints](development/adding-endpoints.md) -- How to add API endpoints
- [Bundle Size](development/bundle-size.md) -- Bundle size tracking and analysis

## For Architects

Understanding the system design and the decisions behind it.

- [Architecture Overview](architecture/overview.md) -- System topology, building blocks, service layout
- [Data Model](architecture/data-model.md) -- D1 registry and DO SQLite schemas
- [Data Flows](architecture/data-flows.md) -- Key flows (webhook sync, onboarding, reconciliation)
- [Queue Contracts](architecture/queue-contracts.md) -- Queue message types and size budgets
- [Correctness Invariants](architecture/correctness-invariants.md) -- The five non-negotiable invariants
- [Platform Limits](architecture/platform-limits.md) -- Cloudflare resource limits and how we respect them

### Architecture Decision Records

- [ADR-001: DO SQLite as primary per-user storage](decisions/adr-001-do-sqlite-storage.md)
- [ADR-002: AccountDO is mandatory](decisions/adr-002-account-do-mandatory.md)
- [ADR-003: No Z3 in MVP](decisions/adr-003-no-z3-mvp.md)
- [ADR-004: Busy overlay calendars by default](decisions/adr-004-busy-overlay-default.md)
- [ADR-005: Event-sourcing via change journal](decisions/adr-005-event-sourcing-journal.md)
- [ADR-006: Daily drift reconciliation](decisions/adr-006-daily-reconciliation.md)
- [ADR-007: Secrets centralized in API worker](decisions/adr-007-secrets-centralization.md)

## For API Consumers

Building clients and integrations against the T-Minus API.

- [API Reference](api/reference.md) -- Endpoints, request/response shapes
- [Authentication](api/authentication.md) -- Bearer tokens and auth flow
- [Error Codes](api/error-codes.md) -- Structured error code taxonomy
- [Response Envelope](api/envelope.md) -- Standard response envelope format

## For Operators

Deploying, monitoring, and maintaining T-Minus in production.

- [Deployment Runbook](operations/deployment.md) -- Full deployment lifecycle
- [Secrets Management](operations/secrets.md) -- Secret registry and rotation
- [Monitoring](operations/monitoring.md) -- Sync health model and alerting
- [Rollback Procedures](operations/rollback.md) -- Worker and D1 rollback
- [Troubleshooting](operations/troubleshooting.md) -- Common issues and fixes

## For Integrators

Understanding provider integrations and extension points.

- [Google Calendar](integrations/google-calendar.md) -- OAuth, sync, webhooks
- [Microsoft Calendar](integrations/microsoft-calendar.md) -- Planned integration (Phase 5)
- [Apple Calendar](integrations/apple-calendar.md) -- CalDAV feed (Phase 5)
- [CalDAV](integrations/caldav.md) -- Read-only CalDAV protocol support
- [MCP](integrations/mcp.md) -- Model Context Protocol server

## For Security Reviewers

Security posture and compliance documentation.

- [Security Overview](security/overview.md) -- Encryption, privacy, tenant isolation
- [CASA Assessment](security/casa-assessment.md) -- Cloud Application Security Assessment

## For Stakeholders

Business context, vision, and roadmap.

- [Vision and Strategy](business/vision.md) -- Problem statement, personas, strategic positioning
- [Roadmap](business/roadmap.md) -- Phase plan and deliverables
- [Personas](business/personas.md) -- Target users and their needs
