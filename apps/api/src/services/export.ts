/**
 * Full Markdown export (pillar #1, the anti-lock-in promise). Produces plain `.md`
 * files with YAML frontmatter plus a manifest — the exact bytes a user could drop into
 * Obsidian. Cheap to build now, expensive to retrofit, so it ships in the foundation.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import { notes } from '../db/schema';
import type { NoteRow } from '../db/schema';
import type { Ctx } from '../context';

export interface ExportFile {
  name: string;
  content: string;
}

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
    `createdAt: ${note.createdAt.toISOString()}`,
    `updatedAt: ${note.updatedAt.toISOString()}`,
    `version: ${note.version}`,
    '---',
    '',
  ];
  return lines.join('\n');
}

/**
 * Collect every live note in the workspace as export files. Foundation workspaces are
 * small, so we build in memory; streaming/pagination is a documented follow-up.
 */
export async function collectExport(ctx: Ctx): Promise<ExportFile[]> {
  const rows = await ctx.db
    .select()
    .from(notes)
    .where(and(eq(notes.workspaceId, ctx.workspaceId), isNull(notes.deletedAt)))
    .orderBy(asc(notes.createdAt));

  const files: ExportFile[] = [];
  const seen = new Map<string, number>();

  for (const note of rows) {
    const base = slug(note.title || 'untitled');
    // De-dupe filenames deterministically.
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const fileBase = n === 0 ? base : `${base}-${n + 1}`;
    const dir = note.folder ? `${note.folder.replace(/^\/+|\/+$/g, '')}/` : '';
    files.push({
      name: `notes/${dir}${fileBase}-${note.id.slice(0, 8)}.md`,
      content: frontmatter(note) + note.bodyMd,
    });
  }

  const manifest = {
    exportedAt: new Date().toISOString(),
    workspaceId: ctx.workspaceId,
    noteCount: rows.length,
    format: 'markdown',
    note: 'Plain Markdown + YAML frontmatter. Your data, portable. Attachments (when '
      + 'present) live under attachments/. See docs/VISION.md pillar #1.',
  };
  files.push({ name: 'manifest.json', content: JSON.stringify(manifest, null, 2) });
  files.push({
    name: 'README.md',
    content: `# Iris export\n\nExported ${manifest.exportedAt}. ${rows.length} note(s).\n\n`
      + `Each file under \`notes/\` is a plain Markdown note with YAML frontmatter.\n`,
  });

  return files;
}
