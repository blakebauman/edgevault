export type { Database, DatabaseConnection, Schema } from './client'
export { createDatabase } from './client'
export {
  type AuthenticatorRow,
  confirmTotpCredential,
  createAuthenticator,
  deleteTotpCredential,
  type EntitlementRow,
  getAccountByProvider,
  getAuthenticatorById,
  getAuthenticatorsByUser,
  getEntitlements,
  getSamlConnection,
  getScimTokenHash,
  getSsoConnection,
  getTotpCredential,
  type SamlConnectionRow,
  type SsoConnectionRow,
  setScimTokenHash,
  type TotpCredentialRow,
  updateAuthenticatorCounter,
  upsertEntitlements,
  upsertSamlConnection,
  upsertSsoConnection,
  upsertTotpSecret,
} from './queries'
export * as schema from './schema'
export * from './schema'
