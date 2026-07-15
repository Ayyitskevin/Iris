-- Iris foundation schema (ADR-002, ADR-003).
-- Hand-authored so it can carry RLS policies and be read in review. Mirrors
-- src/db/schema.ts — keep the two in sync.

-- ── Core tenancy ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workspaces (
  id          uuid PRIMARY KEY,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  password_hash text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_members (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL DEFAULT 'owner',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_members_unique
  ON workspace_members (workspace_id, user_id);

-- ── Notes + versioning (ADR-008) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notes (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title        text NOT NULL DEFAULT '',
  body_md      text NOT NULL DEFAULT '',
  folder       text,
  version      integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
-- Sync change-feed cursor (workspace, updated_at, id). See ADR-005.
CREATE INDEX IF NOT EXISTS notes_sync_idx ON notes (workspace_id, updated_at, id);

CREATE TABLE IF NOT EXISTS note_versions (
  id           uuid PRIMARY KEY,
  note_id      uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  version      integer NOT NULL,
  title        text NOT NULL,
  body_md      text NOT NULL,
  author_type  text NOT NULL,
  author_id    uuid NOT NULL,
  author_name  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS note_versions_unique ON note_versions (note_id, version);

-- ── Agents: scoped, revocable tokens (ADR-009) ──────────────────────────────
CREATE TABLE IF NOT EXISTS agent_tokens (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_name   text NOT NULL,
  token_hash   text NOT NULL,
  token_prefix text NOT NULL,
  scopes       jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

-- ── Append-only activity log (the moat, pillar #2) ──────────────────────────
CREATE TABLE IF NOT EXISTS activity_log (
  id                uuid PRIMARY KEY,
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_type        text NOT NULL,
  actor_id          uuid NOT NULL,
  actor_name        text NOT NULL,
  action            text NOT NULL,
  note_id           uuid,
  note_version_id   uuid,
  resulting_version integer,
  undo_of_id        uuid,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_feed_idx ON activity_log (workspace_id, created_at);

-- ── Devices + billing (ADR-007) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS devices (
  id           text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  platform     text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  workspace_id           uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  plan                   text NOT NULL DEFAULT 'free',
  status                 text NOT NULL DEFAULT 'none',
  stripe_customer_id     text,
  stripe_subscription_id text,
  current_period_end     timestamptz,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- ── Row-Level Security (ADR-003, defense in depth) ──────────────────────────
-- Policies gate every row by the per-transaction GUC `app.current_workspace`
-- (set in withWorkspace()). current_setting(..., true) is NULL when unset, so an
-- un-scoped connection sees nothing (fail closed). These bite on a real cluster
-- where the app connects as a NON-superuser role; superuser connections (e.g.
-- PGlite in dev/test) bypass RLS by design, so the authoritative in-repo proof of
-- isolation is the application-level tenant-isolation test.
--
-- Note: `users` and `agent_tokens` are deliberately NOT under RLS — they are the
-- auth-bootstrap tables, read to establish WHICH workspace a request belongs to
-- (by email, or by token id) before any tenant context exists. They remain
-- app-layer scoped: agent-token listing always filters by workspace_id.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'workspace_members','notes','note_versions',
    'activity_log','devices','subscriptions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY workspace_isolation ON %I
        USING (workspace_id = current_setting('app.current_workspace', true)::uuid)
        WITH CHECK (workspace_id = current_setting('app.current_workspace', true)::uuid)
    $f$, t);
  END LOOP;
END $$;
