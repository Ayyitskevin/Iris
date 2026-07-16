-- Make note organization reversible without inventing folder history that 0001-0003
-- never captured. A NULL folder is a real captured value (the workspace root), so a
-- separate knownness bit distinguishes it from an unknown legacy snapshot.
--
-- Keep the default false for rolling/rollback safety: an older server omits both new
-- fields and therefore produces an honestly incomplete snapshot instead of claiming
-- that a foldered note lived at the root.

-- FORCE RLS would hide other workspaces from a non-BYPASSRLS migration role. Suspend
-- it transactionally while reconstructing only the one snapshot that is provably the
-- current note head; the migration runner verifies both policies are restored.
ALTER TABLE notes DISABLE ROW LEVEL SECURITY;
ALTER TABLE note_versions DISABLE ROW LEVEL SECURITY;

ALTER TABLE note_versions
  ADD COLUMN folder text,
  ADD COLUMN folder_snapshot_known boolean NOT NULL DEFAULT false;

-- The snapshot whose version equals the live note version is reconstructible exactly.
-- Older snapshots remain unknown; copying today's folder backward would fabricate
-- history and could silently move a note during restore.
UPDATE note_versions AS versions
SET folder = notes.folder,
    folder_snapshot_known = true
FROM notes
WHERE notes.workspace_id = versions.workspace_id
  AND notes.id = versions.note_id
  AND notes.version = versions.version;

ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes FORCE ROW LEVEL SECURITY;
ALTER TABLE note_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE note_versions FORCE ROW LEVEL SECURITY;
