-- Sync v2: commit-ordered database cursors and request-bound idempotency.
--
-- A PostgreSQL sequence is not sufficient for a sync cursor: sequence allocation and
-- transaction commit order can invert, allowing a client to advance past a late commit.
-- The per-workspace counter below is locked by a BEFORE STATEMENT trigger, before note
-- rows are locked, and held until commit. A BEFORE ROW trigger then assigns each changed
-- note a unique sequence from that locked counter.

CREATE TABLE IF NOT EXISTS workspace_sync_cursors (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  last_seq     bigint NOT NULL DEFAULT 0
               CONSTRAINT workspace_sync_cursors_last_seq_check
               CHECK (last_seq >= 0)
);

ALTER TABLE notes ADD COLUMN IF NOT EXISTS sync_seq bigint;

-- Foundation tables use FORCE RLS. The migration role must see every legacy note for
-- the backfill and must validate every existing version-to-note relationship, so
-- suspend RLS transactionally while these ACCESS EXCLUSIVE DDL locks are held. A
-- failure rolls every change back; the policies are re-enabled and forced below.
ALTER TABLE notes DISABLE ROW LEVEL SECURITY;
ALTER TABLE note_versions DISABLE ROW LEVEL SECURITY;
ALTER TABLE devices DISABLE ROW LEVEL SECURITY;

-- Client-generated note and device ids identify a resource only inside its workspace.
-- Validate the denormalized version workspace before replacing the legacy global note
-- key; otherwise a historical cross-workspace mismatch could be silently blessed by
-- the new composite foreign key.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM note_versions AS versions
    LEFT JOIN notes
      ON notes.workspace_id = versions.workspace_id
     AND notes.id = versions.note_id
    WHERE notes.id IS NULL
  ) THEN
    RAISE EXCEPTION 'note_versions workspace_id does not match its note workspace';
  END IF;
END $$;

ALTER TABLE note_versions DROP CONSTRAINT IF EXISTS note_versions_note_id_fkey;
ALTER TABLE notes DROP CONSTRAINT IF EXISTS notes_pkey;
ALTER TABLE notes
  ADD CONSTRAINT notes_pkey PRIMARY KEY (workspace_id, id);
ALTER TABLE note_versions
  ADD CONSTRAINT note_versions_note_id_fkey
  FOREIGN KEY (workspace_id, note_id)
  REFERENCES notes (workspace_id, id)
  ON DELETE CASCADE;

DROP INDEX IF EXISTS note_versions_unique;
CREATE UNIQUE INDEX note_versions_unique
  ON note_versions (workspace_id, note_id, version);

ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_pkey;
ALTER TABLE devices
  ADD CONSTRAINT devices_pkey PRIMARY KEY (workspace_id, id);

-- A rerun sees the triggers created at the bottom of this file. Disable only these
-- migration-owned triggers while the deterministic backfill statement runs.
DROP TRIGGER IF EXISTS notes_sync_cursor_lock ON notes;
DROP TRIGGER IF EXISTS notes_sync_seq_assign ON notes;

-- Existing clients may hold timestamp cursors. The API intentionally replays this
-- deterministic backfill once and then returns a v2 cursor.
WITH ranked AS (
  SELECT
    workspace_id,
    id,
    row_number() OVER (
      PARTITION BY workspace_id
      ORDER BY updated_at, id
    )::bigint AS sync_seq
  FROM notes
  WHERE sync_seq IS NULL
)
UPDATE notes AS n
SET sync_seq = ranked.sync_seq
FROM ranked
WHERE n.workspace_id = ranked.workspace_id
  AND n.id = ranked.id;

INSERT INTO workspace_sync_cursors AS cursors (workspace_id, last_seq)
SELECT w.id, COALESCE(MAX(n.sync_seq), 0)
FROM workspaces AS w
LEFT JOIN notes AS n ON n.workspace_id = w.id
GROUP BY w.id
ON CONFLICT (workspace_id) DO UPDATE
SET last_seq = GREATEST(cursors.last_seq, EXCLUDED.last_seq);

ALTER TABLE notes ALTER COLUMN sync_seq SET NOT NULL;
ALTER TABLE notes ALTER COLUMN sync_seq SET DEFAULT 0;

DROP INDEX IF EXISTS notes_sync_idx;
CREATE UNIQUE INDEX notes_sync_idx ON notes (workspace_id, sync_seq);

CREATE TABLE IF NOT EXISTS sync_idempotency (
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  op_id              text NOT NULL,
  actor_type         text NOT NULL,
  actor_id           uuid NOT NULL,
  device_id          text NOT NULL,
  receipt_version    smallint NOT NULL DEFAULT 1
                     CONSTRAINT sync_idempotency_receipt_version_check
                     CHECK (receipt_version >= 1),
  request_fingerprint text NOT NULL,
  outcome            jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, op_id)
);

-- Both tables are tenant state and receive the same defense-in-depth policy as notes.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspace_sync_cursors', 'sync_idempotency'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = current_schema()
        AND tablename = t
        AND policyname = 'workspace_isolation'
    ) THEN
      EXECUTE format($policy$
        CREATE POLICY workspace_isolation ON %I
          USING (workspace_id = current_setting('app.current_workspace', true)::uuid)
          WITH CHECK (workspace_id = current_setting('app.current_workspace', true)::uuid)
      $policy$, t);
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION iris_lock_workspace_sync_cursor()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_workspace text := current_setting('app.current_workspace', true);
BEGIN
  IF current_workspace IS NULL OR current_workspace = '' THEN
    RAISE EXCEPTION 'note mutation requires app.current_workspace';
  END IF;

  INSERT INTO workspace_sync_cursors AS cursors (workspace_id, last_seq)
  VALUES (current_workspace::uuid, 0)
  ON CONFLICT (workspace_id) DO UPDATE
  SET last_seq = cursors.last_seq;

  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION iris_assign_note_sync_seq()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_workspace uuid :=
    NULLIF(current_setting('app.current_workspace', true), '')::uuid;
BEGIN
  IF current_workspace IS NULL OR NEW.workspace_id <> current_workspace THEN
    RAISE EXCEPTION 'note workspace must match app.current_workspace';
  END IF;

  UPDATE workspace_sync_cursors
  SET last_seq = last_seq + 1
  WHERE workspace_id = NEW.workspace_id
  RETURNING last_seq INTO NEW.sync_seq;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace sync cursor was not locked before note mutation';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER notes_sync_cursor_lock
BEFORE INSERT OR UPDATE ON notes
FOR EACH STATEMENT
EXECUTE FUNCTION iris_lock_workspace_sync_cursor();

CREATE TRIGGER notes_sync_seq_assign
BEFORE INSERT OR UPDATE ON notes
FOR EACH ROW
EXECUTE FUNCTION iris_assign_note_sync_seq();

ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes FORCE ROW LEVEL SECURITY;
ALTER TABLE note_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE note_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices FORCE ROW LEVEL SECURITY;
