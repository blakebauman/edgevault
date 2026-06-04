CREATE TABLE "entitlements" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"entitlements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;