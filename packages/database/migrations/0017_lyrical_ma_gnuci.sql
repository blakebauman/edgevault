ALTER TABLE "sessions" ADD COLUMN "auth_method" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "require_mfa" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "sso_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "allowed_cidrs" jsonb;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "ai_indexing_enabled" boolean DEFAULT true NOT NULL;