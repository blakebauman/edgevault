export type { Database, DatabaseConnection, Schema } from './client'
export { createDatabase } from './client'
export {
  type EntitlementRow,
  getEntitlements,
  getSamlConnection,
  getScimTokenHash,
  getSsoConnection,
  type SamlConnectionRow,
  type SsoConnectionRow,
  setScimTokenHash,
  upsertEntitlements,
  upsertSamlConnection,
  upsertSsoConnection,
} from './queries'
export * as schema from './schema'
export * from './schema'
