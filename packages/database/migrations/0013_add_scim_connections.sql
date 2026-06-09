CREATE TABLE "scim_connections" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scim_connections" ADD CONSTRAINT "scim_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Restore SCIM token hashes preserved from the dropped entitlements table (0012).
INSERT INTO "scim_connections" ("organization_id", "token_hash")
	SELECT "organization_id", "scim_token_hash" FROM "entitlements_scim_backup";
--> statement-breakpoint
DROP TABLE "entitlements_scim_backup";
