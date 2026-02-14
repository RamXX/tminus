/**
 * @tminus/d1-registry -- D1 registry schema and types.
 *
 * Provides the migration SQL and TypeScript row types for the D1
 * cross-user registry database (routing, identity, compliance).
 */

export { MIGRATION_0001_INITIAL_SCHEMA, MIGRATION_0002_MS_SUBSCRIPTIONS, ALL_MIGRATIONS } from "./schema";

export type {
  OrgRow,
  UserRow,
  AccountRow,
  AccountStatus,
  MsSubscriptionRow,
  DeletionCertificateRow,
  DeletionEntityType,
} from "./types";
