CREATE TYPE "public"."custom_domain_status" AS ENUM('pending_dcv', 'pending_ssl', 'active', 'failed');--> statement-breakpoint
CREATE TABLE "custom_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"hostname" text NOT NULL,
	"cf_custom_hostname_id" text NOT NULL,
	"status" "custom_domain_status" DEFAULT 'pending_dcv' NOT NULL,
	"failure_reason" text,
	"dcv_records" jsonb,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "custom_domains" ADD CONSTRAINT "custom_domains_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_domains" ADD CONSTRAINT "custom_domains_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_domains_hostname_key" ON "custom_domains" USING btree ("hostname");--> statement-breakpoint
CREATE INDEX "custom_domains_org_idx" ON "custom_domains" USING btree ("organization_id");