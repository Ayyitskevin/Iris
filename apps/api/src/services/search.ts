/**
 * Full-text search + tag listing (phase 2). Search uses the generated `search_vector`
 * tsvector column (migration 0002) ranked by ts_rank; both are workspace-scoped and
 * skip tombstones. Tag counts are aggregated in-process (fine at foundation scale;
 * the GIN index on `tags` still accelerates the per-tag filter in listNotes).
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { SearchHit, TagSummary } from '@iris/shared';
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
  const rows = await ctx.db
    .select({ tags: notes.tags })
    .from(notes)
    .where(and(eq(notes.workspaceId, ctx.workspaceId), isNull(notes.deletedAt)));

  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const t of r.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
