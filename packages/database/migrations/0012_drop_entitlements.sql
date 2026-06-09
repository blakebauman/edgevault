-- Entitlements are removed: SSO/SCIM are now core (ungated). Preserve any
-- configured SCIM token hashes so existing provisioning survives the move to
-- scim_connections (created in 0013); the backup table is dropped there.
CREATE TABLE "entitlements_scim_backup" AS
	SELECT "organization_id", "scim_token_hash"
	FROM "entitlements"
	WHERE "scim_token_hash" IS NOT NULL;
--> statement-breakpoint
DROP TABLE "entitlements" CASCADE;
