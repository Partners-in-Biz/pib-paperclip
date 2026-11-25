-- PAR-13930 (Canvas C1): board scope and sharing columns, item rows, comments,
-- agent grants and op batches, plus a one-time backfill of item rows from the
-- legacy jsonb blob. Additive and idempotent: every statement can be replayed.
-- Rollback: revert the later canvas tickets first, then drop the four new
-- tables and the new columns (user_id NOT NULL can only come back once no
-- board has a null owner).
ALTER TABLE "planning_canvases" ADD COLUMN IF NOT EXISTS "scope" text NOT NULL DEFAULT 'personal';
--> statement-breakpoint
ALTER TABLE "planning_canvases" ADD COLUMN IF NOT EXISTS "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "planning_canvases" ADD COLUMN IF NOT EXISTS "member_access" text NOT NULL DEFAULT 'view';
--> statement-breakpoint
ALTER TABLE "planning_canvases" ADD COLUMN IF NOT EXISTS "revision" bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "planning_canvases" ADD COLUMN IF NOT EXISTS "purged_through_revision" bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "planning_canvases" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "planning_canvases" ADD COLUMN IF NOT EXISTS "created_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "planning_canvases" ADD COLUMN IF NOT EXISTS "legacy_data_md5" text;
--> statement-breakpoint
ALTER TABLE "planning_canvases" ALTER COLUMN "user_id" DROP NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'planning_canvases_scope_check') THEN
    ALTER TABLE "planning_canvases" ADD CONSTRAINT "planning_canvases_scope_check"
      CHECK ("scope" IN ('personal', 'project', 'company'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'planning_canvases_member_access_check') THEN
    ALTER TABLE "planning_canvases" ADD CONSTRAINT "planning_canvases_member_access_check"
      CHECK ("member_access" IN ('edit', 'comment', 'view'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'planning_canvases_personal_owner_check') THEN
    ALTER TABLE "planning_canvases" ADD CONSTRAINT "planning_canvases_personal_owner_check"
      CHECK ("user_id" IS NOT NULL OR "scope" <> 'personal');
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "planning_canvases_company_scope_project_updated_idx"
  ON "planning_canvases" ("company_id", "scope", "project_id", "updated_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "planning_canvas_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "board_id" uuid NOT NULL REFERENCES "planning_canvases"("id") ON DELETE CASCADE,
  "item_key" text NOT NULL,
  "item_type" text NOT NULL,
  "kind" text,
  "data" jsonb NOT NULL,
  "z_index" integer,
  "version" integer NOT NULL DEFAULT 1,
  "field_versions" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "revision" bigint NOT NULL,
  "deleted_at" timestamp with time zone,
  "deleted_with_key" text,
  "updated_by_user_id" text,
  "updated_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "planning_canvas_items_item_key_check" CHECK (char_length("item_key") BETWEEN 1 AND 100),
  CONSTRAINT "planning_canvas_items_item_type_check" CHECK ("item_type" IN ('node', 'connector', 'stroke'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "planning_canvas_items_board_key_uq"
  ON "planning_canvas_items" ("board_id", "item_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "planning_canvas_items_board_revision_idx"
  ON "planning_canvas_items" ("board_id", "revision");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "planning_canvas_comments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "board_id" uuid NOT NULL REFERENCES "planning_canvases"("id") ON DELETE CASCADE,
  "item_key" text,
  "parent_id" uuid REFERENCES "planning_canvas_comments"("id") ON DELETE CASCADE,
  "body" text NOT NULL,
  "author_user_id" text,
  "author_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "linked_issue_id" uuid REFERENCES "issues"("id") ON DELETE SET NULL,
  "mention_state" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "resolved_at" timestamp with time zone,
  "resolved_by_user_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "deleted_at" timestamp with time zone,
  CONSTRAINT "planning_canvas_comments_body_check" CHECK (char_length("body") BETWEEN 1 AND 10000)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "planning_canvas_comments_board_item_created_idx"
  ON "planning_canvas_comments" ("board_id", "item_key", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "planning_canvas_agent_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "board_id" uuid NOT NULL REFERENCES "planning_canvases"("id") ON DELETE CASCADE,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "granted_by_user_id" text NOT NULL,
  "source" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "revoked_at" timestamp with time zone,
  CONSTRAINT "planning_canvas_agent_grants_source_check" CHECK ("source" IN ('mention', 'handoff'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "planning_canvas_agent_grants_board_agent_issue_uq"
  ON "planning_canvas_agent_grants" ("board_id", "agent_id", "issue_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "planning_canvas_op_batches" (
  "board_id" uuid NOT NULL REFERENCES "planning_canvases"("id") ON DELETE CASCADE,
  "actor_key" text NOT NULL,
  "client_batch_id" text NOT NULL,
  "results" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "planning_canvas_op_batches_pk" PRIMARY KEY ("board_id", "actor_key", "client_batch_id"),
  CONSTRAINT "planning_canvas_op_batches_client_batch_id_check" CHECK (char_length("client_batch_id") BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "planning_canvas_op_batches_board_created_idx"
  ON "planning_canvas_op_batches" ("board_id", "created_at");
--> statement-breakpoint
-- Backfill: one item row per node, connector and stroke of every board not yet
-- backfilled (legacy_data_md5 IS NULL). The first element per key by array
-- position wins (nodes, then connectors, then strokes); later duplicates are
-- skipped and counted in a NOTICE. Connectors and strokes keep their draw
-- order in z_index. Every migrated item names the board owner as last writer.
DO $$
DECLARE
  candidate_count bigint;
  distinct_count bigint;
  inserted_count bigint;
BEGIN
  CREATE TEMP TABLE planning_canvas_backfill ON COMMIT DROP AS
  WITH boards AS (
    SELECT b.id, b.company_id, b.user_id, b.data
    FROM planning_canvases b
    WHERE b.legacy_data_md5 IS NULL
  ),
  elements AS (
    SELECT b.id AS board_id, b.company_id, b.user_id, 'node'::text AS item_type, 1 AS type_order, e.elem, e.ord
    FROM boards b
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(b.data->'nodes') = 'array' THEN b.data->'nodes' ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS e(elem, ord)
    UNION ALL
    SELECT b.id, b.company_id, b.user_id, 'connector', 2, e.elem, e.ord
    FROM boards b
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(b.data->'connectors') = 'array' THEN b.data->'connectors' ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS e(elem, ord)
    UNION ALL
    SELECT b.id, b.company_id, b.user_id, 'stroke', 3, e.elem, e.ord
    FROM boards b
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(b.data->'strokes') = 'array' THEN b.data->'strokes' ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS e(elem, ord)
  ),
  keyed AS (
    SELECT
      el.*,
      (jsonb_typeof(el.elem->'id') = 'string' AND char_length(el.elem->>'id') BETWEEN 1 AND 100) AS valid_id
    FROM elements el
    WHERE jsonb_typeof(el.elem) = 'object'
  )
  SELECT
    k.board_id,
    k.company_id,
    k.user_id,
    k.item_type,
    k.type_order,
    k.ord,
    CASE WHEN k.valid_id THEN k.elem->>'id' ELSE 'legacy_' || md5(k.elem::text) END AS item_key,
    k.elem,
    k.valid_id
  FROM keyed k;

  SELECT count(*), count(DISTINCT (board_id, item_key))
  INTO candidate_count, distinct_count
  FROM planning_canvas_backfill;

  IF candidate_count > distinct_count THEN
    RAISE NOTICE 'planning_canvas_items backfill skipped % duplicate item key(s)', candidate_count - distinct_count;
  END IF;

  INSERT INTO planning_canvas_items (
    company_id, board_id, item_key, item_type, kind, data, z_index,
    version, field_versions, revision, updated_by_user_id
  )
  SELECT DISTINCT ON (s.board_id, s.item_key)
    s.company_id,
    s.board_id,
    s.item_key,
    s.item_type,
    CASE WHEN s.item_type = 'node' THEN s.elem->>'kind' END,
    (
      CASE s.item_type
        WHEN 'node' THEN
          (s.elem - 'id' - 'handedOffIssueId' - 'handedOffIssueIdentifier')
          || CASE
               WHEN jsonb_typeof(s.elem->'handedOffIssueId') = 'string'
                 THEN jsonb_build_object('links', jsonb_build_array(
                   jsonb_build_object('type', 'issue', 'issueId', s.elem->'handedOffIssueId')))
               ELSE '{}'::jsonb
             END
        WHEN 'connector' THEN
          (s.elem - 'id' - 'fromNodeId' - 'toNodeId')
          || jsonb_build_object('fromKey', s.elem->'fromNodeId', 'toKey', s.elem->'toNodeId')
        ELSE s.elem - 'id'
      END
    )
    || CASE WHEN s.valid_id THEN '{}'::jsonb ELSE jsonb_build_object('legacyId', s.elem->'id') END,
    CASE
      WHEN s.item_type <> 'node' THEN s.ord::integer
      WHEN jsonb_typeof(s.elem->'zIndex') = 'number'
        THEN least(greatest(floor((s.elem->>'zIndex')::numeric), 0), 100000)::integer
      ELSE 1
    END,
    1,
    '{}'::jsonb,
    1,
    s.user_id
  FROM planning_canvas_backfill s
  ORDER BY s.board_id, s.item_key, s.type_order, s.ord
  ON CONFLICT (board_id, item_key) DO NOTHING;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RAISE NOTICE 'planning_canvas_items backfill inserted % item row(s)', inserted_count;

  UPDATE planning_canvases
  SET revision = greatest(revision, 1),
      legacy_data_md5 = md5(data::text)
  WHERE legacy_data_md5 IS NULL;

  DROP TABLE planning_canvas_backfill;
END $$;
