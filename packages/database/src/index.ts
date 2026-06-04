export type { Database, DatabaseConnection, Schema } from './client'
export { createDatabase } from './client'
export {
  type EntitlementRow,
  getEntitlements,
  getScimTokenHash,
  setScimTokenHash,
  upsertEntitlements,
} from './queries'
export * as schema from './schema'
export * from './schema'
