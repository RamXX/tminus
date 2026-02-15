/**
 * Worker environment bindings for the push notification worker.
 *
 * DB: D1 registry database containing device_tokens and users tables.
 * USER_GRAPH: Durable Object namespace for UserGraphDO (notification preferences).
 * PUSH_QUEUE: Queue consumer for push notification messages.
 * APNS_KEY_ID: APNs authentication key ID.
 * APNS_TEAM_ID: Apple Developer Team ID.
 * APNS_PRIVATE_KEY: APNs .p8 private key (PEM format).
 * APNS_TOPIC: App bundle ID for APNs (e.g., "ink.tminus.app").
 */
interface Env {
  DB: D1Database;
  USER_GRAPH: DurableObjectNamespace;
  PUSH_QUEUE: Queue;
  APNS_KEY_ID: string;
  APNS_TEAM_ID: string;
  APNS_PRIVATE_KEY: string;
  APNS_TOPIC: string;
  ENVIRONMENT: string;
}
