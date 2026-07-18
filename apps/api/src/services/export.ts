/**
 * Full Markdown export (pillar #1, the anti-lock-in promise). Produces plain `.md`
 * files with YAML frontmatter plus a manifest — the exact bytes a user could drop into
 * Obsidian. Cheap to build now, expensive to retrofit, so it ships in the foundation.
 */
import { and, asc, eq, gt, isNull, or, type SQL } from 'drizzle-orm';
import { notes } from '../db/schema';
import type { NoteRow } from '../db/schema';
import type { Ctx } from '../context';

export interface ExportFile {
  name: string;
  content: string;
}

// Notes are read one page at a time so a large workspace never materializes in full. The
// caller appends each yielded file to the archive between pages; that per-page `await` is
// also what lets the zip writer drain to disk, keeping peak memory at ~one page, not O(all).
const EXPORT_PAGE_SIZE = 500;

function slug(input: string): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || 'untitled';
}

function frontmatter(note: NoteRow): string {
  const lines = [
    '---',
    `id: ${note.id}`,
    `title: ${JSON.stringify(note.title)}`,
    `folder: ${note.folder ? JSON.stringify(note.folder) : 'null'}`,
    `tags: [${(note.tags ?? []).map((t) => JSON.stringify(t)).join(', ')}]`,
    `createdAt: ${note.createdAt.toISOString()}`,
    `updatedAt: ${note.updatedAt.toISOString()}`,
    `version: ${note.version}`,
    '---',
    '',
  ];
  return lines.join('\n');
}

/** Deterministic, collision-free file name for a note, given the slugs already emitted. */
function exportFileName(note: NoteRow, seen: Map<string, number>): string {
  const base = slug(note.title || 'untitled');
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  const fileBase = n === 0 ? base : `${base}-${n + 1}`;
  const dir = note.folder ? `${note.folder.replace(/^\/+|\/+$/g, '')}/` : '';
  return `notes/${dir}${fileBase}-${note.id.slice(0, 8)}.md`;
}

/**
 * Yield every live note in the workspace as an export file, then a manifest and README.
 * Reads in keyset-paged batches ordered by (createdAt, id) — a stable total order, so the
 * de-dup suffixing is deterministic and the stream holds only one page at a time.
 */
export async function* exportFiles(ctx: Ctx): AsyncGenerator<ExportFile> {
  const base: SQL | undefined = and(
    eq(notes.workspaceId, ctx.workspaceId),
    isNull(notes.deletedAt),
  );
  const seen = new Map<string, number>();
  let noteCount = 0;
  let after: { createdAt: Date; id: string } | null = null;

  for (;;) {
    // Keyset pagination: everything strictly after the last (createdAt, id) we emitted.
    const where: SQL | undefined = after
      ? and(
          base,
          or(
            gt(notes.createdAt, after.createdAt),
            and(eq(notes.createdAt, after.createdAt), gt(notes.id, after.id)),
          ),
        )
      : base;
    const page: NoteRow[] = await ctx.db
      .select()
      .from(notes)
      .where(where)
      .orderBy(asc(notes.createdAt), asc(notes.id))
      .limit(EXPORT_PAGE_SIZE);
    if (page.length === 0) break;

    for (const note of page) {
      yield { name: exportFileName(note, seen), content: frontmatter(note) + note.bodyMd };
      noteCount++;
    }

    const last = page[page.length - 1]!;
    after = { createdAt: last.createdAt, id: last.id };
    if (page.length < EXPORT_PAGE_SIZE) break;
  }

  const manifest = {
    exportedAt: new Date().toISOString(),
    workspaceId: ctx.workspaceId,
    noteCount,
    format: 'markdown',
    note:
      'Plain Markdown + YAML frontmatter. Your data, portable. Attachments (when ' +
      'present) live under attachments/. See docs/VISION.md pillar #1.',
  };
  yield { name: 'manifest.json', content: JSON.stringify(manifest, null, 2) };
  yield {
    name: 'README.md',
    content:
      `# Iris export\n\nExported ${manifest.exportedAt}. ${noteCount} note(s).\n\n` +
      `Each file under \`notes/\` is a plain Markdown note with YAML frontmatter.\n`,
  };
}
