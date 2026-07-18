---
name: search-and-tags
description: Open when touching note tags (the jsonb array, filtering, the tag list) or full-text search (the generated tsvector column, ranking) — added in phase 2 (ADR-010).
---

## When to use

Anything involving tags or search: adding a tag-aware endpoint, changing tag
normalization, debugging why a tag filter returns nothing, tuning search ranking, or
extending the FTS (snippets, weights, combined tag+query filters).

## Mental model

Two additive features on the existing note spine (ADR-010). **Tags** are a `jsonb`
string array that lives _on the note_ (and on every version snapshot), so they sync,
export, and version for free — no join table. **Search** is Postgres FTS over a
_generated, stored_ `tsvector` column with a GIN index, ranked by `ts_rank`. Both are
workspace-scoped and skip tombstones like every other read. PGlite runs the identical
FTS, so both are fully tested in-repo.

## Key files

- `apps/api/migrations/0002_search_and_tags.sql` — adds `notes.tags` + `note_versions.tags`
  (jsonb), the generated `search_vector tsvector`, and GIN indexes on both.
- `apps/api/src/db/schema.ts` — `tags` modeled on both tables; `search_vector` is
  **deliberately not modeled** (DB-generated; never inserted/selected via Drizzle).
- `apps/api/src/services/search.ts` — `searchNotes` (Drizzle select with a raw
  `ts_rank`/`@@` over `search_vector`) and `listTags` (in-process count aggregation).
- `apps/api/src/services/notes.ts` — `normalizeTags` (trim/lowercase/de-dupe) at the
  service boundary; `listNotes(ctx, tag?)` uses the jsonb `?` operator to filter.
- `apps/api/src/services/note-write.ts` — the version snapshot copies `note.tags` (alongside
  the folder + lifecycle), so **both** direct version restore and activity undo carry tags
  forward. Tags are never gated by a `known` flag (the column is `NOT NULL DEFAULT []`), so tag
  restore never fails closed — unlike folder/lifecycle, which can be legacy-unknown.
- `packages/shared/src/schemas.ts` — `tags` on `Note`/`NoteVersion`/`Create`/`Update`/
  `SyncMutation`; `TagSummary`/`TagListResponse`/`SearchHit`/`SearchResponse`.
- `apps/api/src/app.ts` — routes `GET /v1/notes/search`, `GET /v1/tags`, and `?tag=` on
  `GET /v1/notes`. **Order matters**: `/v1/notes/search` is static so Fastify routes it
  ahead of `/v1/notes/:id`.
- Client: `apps/mobile/app/(app)/notes/index.tsx` (debounced search box → `api.searchNotes`
  with a local substring fallback; tag chips from `selectTags`) and `.../notes/[id].tsx`
  (comma-separated tags input, committed on blur).
- Tests: `apps/api/test/search-tags.test.ts`.

## Playbook — add a tag-aware or search feature

1. **Wire shape first** (`packages/shared/src/schemas.ts`): add/extend the zod type; both
   ends pick it up at compile time.
2. **Tags travel with the note.** If you add a place notes are written (a new mutation
   path), pass `normalizeTags(input.tags)` into the insert/update **and** rely on
   `recordVersionAndActivity` to snapshot them — don't hand-roll a second snapshot.
3. **Filtering by tag** = `sql\`${notes.tags} ? ${tag}\``in the`where` (jsonb membership,
GIN-indexed). Aggregate counts either in-process (`listTags`) or via
`jsonb_array_elements_text` if you need it in SQL.
4. **Search** = reference the generated column by raw name in a Drizzle select:
   `sql\`search_vector @@ plainto_tsquery('english', ${term})\``and rank with`ts_rank(search_vector, …)`. Short-circuit empty queries to `[]`.
5. **Test it** against PGlite (`makeApp`/`call`) exactly like `search-tags.test.ts` —
   including a workspace-isolation case.

## Invariants & gotchas

- **`search_vector` is generated + immutable-by-construction.** Its config is the constant
  `'english'`; keep it constant or the generated column becomes invalid. Never insert/select
  it through Drizzle — it's not in the schema on purpose (selecting it would pull a tsvector
  Drizzle can't map).
- **Normalize tags once, at the service boundary.** `normalizeTags` lowercases/de-dupes, so
  the DB only ever holds canonical tags — filters and counts assume that.
- **Tags are versioned and fully reversible.** Both direct restore (`POST /v2/notes/:id/restore`)
  and activity undo (`POST /v2/activity/:id/undo`) read `note_versions.tags` and restore them;
  `note_versions` also snapshots folder (`folder_snapshot_known`) and lifecycle (`is_deleted`).
  Tags never fail closed (always present); folder/lifecycle can be legacy-unknown and gate on
  `incomplete_version_snapshot` (restore) / `incomplete_history` (undo). See the
  notes-and-versioning and activity-and-undo skills.
- **Route order:** if you add more `/v1/notes/...` static routes, they must stay ahead of
  `/:id` (Fastify handles static-before-param, but keep them grouped to avoid confusion).
- **Scale caveats (documented, not bugs):** `listTags` aggregates in memory and search is
  capped at 50 hits — fine at foundation scale; see ROADMAP for the upgrades.
- Client search falls back to a **local substring filter** when offline — it is intentionally
  dumber than server FTS (no stemming/ranking); don't "fix" the mismatch.
