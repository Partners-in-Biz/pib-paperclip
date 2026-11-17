-- Per-person access (PAR-12608 4.2): additive, every default means "as today" (no member restricted, every company mode off).
-- Undo: ALTER TABLE "companies" DROP CONSTRAINT "companies_member_restriction_mode_check"; ALTER TABLE "companies" DROP COLUMN "member_restriction_mode";
--   ALTER TABLE "company_memberships" DROP COLUMN "restricted", DROP COLUMN "restricted_plugin_keys", DROP COLUMN "restricted_agent_ids";
ALTER TABLE "companies" ADD COLUMN "member_restriction_mode" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "company_memberships" ADD COLUMN "restricted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "company_memberships" ADD COLUMN "restricted_plugin_keys" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "company_memberships" ADD COLUMN "restricted_agent_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_member_restriction_mode_check" CHECK ("companies"."member_restriction_mode" IN ('off', 'report', 'enforce'));