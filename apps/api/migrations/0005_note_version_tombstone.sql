-- Make logical tombstone state reversible without fabricating legacy history.
-- NULL is deliberately the unknown state: false means a captured live note and true
-- means a captured tombstone. Keeping the column nullable with no default makes writes
-- from an older rolled-back server fail safe instead of manufacturing known-live state.

-- FORCE RLS would hide other workspaces from a non-BYPASSRLS migration role. Suspend
-- it transactionally while reconstructing only the snapshot that provably matches the
-- current note head; the migration runner verifies both policies are restored.
ALTER TABLE notes DISABLE ROW LEVEL SECURITY;
ALTER TABLE note_versions DISABLE ROW LEVEL SECURITY;

ALTER TABLE note_versions
  ADD COLUMN is_deleted boolean;

-- A matching current-head snapshot can recover the note's logical deleted/live state.
-- Older snapshots remain NULL because notes.deleted_at cannot prove their past state.
UPDATE note_versions AS versions
SET is_deleted = (notes.deleted_at IS NOT NULL)
FROM notes
WHERE notes.workspace_id = versions.workspace_id
  AND notes.id = versions.note_id
  AND notes.version = versions.version;

ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes FORCE ROW LEVEL SECURITY;
ALTER TABLE note_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE note_versions FORCE ROW LEVEL SECURITY;
