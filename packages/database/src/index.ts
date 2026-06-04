export type { Database, DatabaseConnection, Schema } from './client'
export { createDatabase } from './client'
export {
  confirmTotpCredential,
  deleteTotpCredential,
  type EntitlementRow,
  getEntitlements,
  getSamlConnection,
  getScimTokenHash,
  getSsoConnection,
  getTotpCredential,
  type SamlConnectionRow,
  type SsoConnectionRow,
  setScimTokenHash,
  type TotpCredentialRow,
  upsertEntitlements,
  upsertSamlConnection,
  upsertSsoConnection,
  upsertTotpSecret,
} from './queries'
export * as schema from './schema'
export * from './schema'
