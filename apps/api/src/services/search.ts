/**
 * Full-text search + tag listing (phase 2). Search uses the generated `search_vector`
 * tsvector column (migration 0002) ranked by ts_rank; both are workspace-scoped and
 * skip tombstones. Tag counts are aggregated in-process (fine at foundation scale;
 * the GIN index on `tags` still accelerates the per-tag filter in listNotes).
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { TAG_LIST_MAX, type SearchHit, type TagSummary } from '@iris/shared';
import { notes } from '../db/schema';
import type { NoteRow } from '../db/schema';
import type { Ctx } from '../context';
import { serializeNote } from '../serialize';

const SEARCH_LIMIT = 50;

export async function searchNotes(ctx: Ctx, query: string): Promise<SearchHit[]> {
  const term = query.trim();
  if (!term) return [];

  const tsquery = sql`plainto_tsquery('english', ${term})`;
  const rank = sql<number>`ts_rank(search_vector, ${tsquery})`;

  const rows = await ctx.db
    .select({
      id: notes.id,
      workspaceId: notes.workspaceId,
      title: notes.title,
      bodyMd: notes.bodyMd,
      folder: notes.folder,
      syncSeq: notes.syncSeq,
      tags: notes.tags,
      version: notes.version,
      createdAt: notes.createdAt,
      updatedAt: notes.updatedAt,
      deletedAt: notes.deletedAt,
      rank,
    })
    .from(notes)
    .where(
      and(
        eq(notes.workspaceId, ctx.workspaceId),
        isNull(notes.deletedAt),
        sql`search_vector @@ ${tsquery}`,
      ),
    )
    .orderBy(desc(rank), desc(notes.updatedAt))
    .limit(SEARCH_LIMIT);

  return rows.map((r) => ({ note: serializeNote(r as NoteRow), rank: Number(r.rank) }));
}

export async function listTags(ctx: Ctx): Promise<TagSummary[]> {
  // Aggregate in the database (audit #13). The previous version pulled every live note's tag
  // array into app memory to count in-process; unnesting + GROUP BY does the counting in the
  // DB, so only the distinct tags cross the wire. `count` is cast to int4 so both drivers
  // return it as a JS number (COUNT(*) is bigint, which node-postgres would hand back as a
  // string). Sort matches the old output: most-used first, ties broken by tag name.
  const result = await ctx.db.execute(sql`
    SELECT tag, COUNT(*)::int AS count
    FROM notes
    CROSS JOIN LATERAL jsonb_array_elements_text(notes.tags) AS tag
    WHERE notes.workspace_id = ${ctx.workspaceId} AND notes.deleted_at IS NULL
    GROUP BY tag
    ORDER BY count DESC, tag ASC
    LIMIT ${TAG_LIST_MAX}
  `);
  const rows = (result as unknown as { rows: Array<{ tag: string; count: number }> }).rows;
  return rows.map((r) => ({ tag: r.tag, count: Number(r.count) }));
}
