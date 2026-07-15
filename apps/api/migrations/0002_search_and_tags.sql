-- Phase 2: tags (an organizational primitive alongside folders) + full-text search.
-- Tags travel with the note (and its version snapshots), so they sync and export for
-- free and are part of history. Search is a generated tsvector + GIN index.

-- Tags as a jsonb string array (consistent with agent_tokens.scopes). The jsonb `?`
-- operator filters by element; jsonb_array_elements_text powers the tag list.
ALTER TABLE notes         ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE note_versions ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Full-text search: a stored, generated tsvector over title + body. Immutable because
-- the text-search config is a constant ('english'), so it's valid in a generated column.
ALTER TABLE notes ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body_md, ''))
  ) STORED;

CREATE INDEX IF NOT EXISTS notes_search_idx ON notes USING gin (search_vector);
CREATE INDEX IF NOT EXISTS notes_tags_idx   ON notes USING gin (tags);
