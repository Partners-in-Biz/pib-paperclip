CREATE TABLE IF NOT EXISTS "planning_canvases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "title" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "data" jsonb NOT NULL DEFAULT '{"nodes":[],"connectors":[],"viewport":{"x":0,"y":0,"zoom":1}}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "planning_canvases_company_user_updated_idx"
  ON "planning_canvases" ("company_id", "user_id", "updated_at");
