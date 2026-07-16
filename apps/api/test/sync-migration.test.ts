import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { applyMigrationsPglite, migrationSql } from '../src/db/migrate';

describe('Sync v2 migration', () => {
  it('upgrades a populated legacy database through the supported runner', async () => {
    const client = new PGlite();
    try {
      const migrations = migrationSql();
      const syncV2 = migrations.find((migration) => migration.name === '0003_sync_v2.sql');
      const organization = migrations.find(
        (migration) => migration.name === '0004_note_version_organization.sql',
      );
      const tombstone = migrations.find(
        (migration) => migration.name === '0005_note_version_tombstone.sql',
      );
      expect(syncV2).toBeDefined();
      expect(organization).toBeDefined();
      expect(tombstone).toBeDefined();
      for (const migration of migrations.filter((item) => item.name < '0003_sync_v2.sql')) {
        await client.exec(migration.sql);
      }

      const workspaceA = randomUUID();
      const workspaceB = randomUUID();
      const noteA1 = randomUUID();
      const noteA2 = randomUUID();
      const noteB1 = randomUUID();
      await client.query('INSERT INTO workspaces (id, name) VALUES ($1, $2), ($3, $4)', [
        workspaceA,
        'Workspace A',
        workspaceB,
        'Workspace B',
      ]);
      await client.query(
        `INSERT INTO notes (id, workspace_id, title, updated_at)
         VALUES ($1, $2, $3, $4), ($5, $2, $6, $7), ($8, $9, $10, $11)`,
        [
          noteA1,
          workspaceA,
          'A one',
          '2026-01-01T00:00:00.000Z',
          noteA2,
          'A two',
          '2026-01-02T00:00:00.000Z',
          noteB1,
          workspaceB,
          'B one',
          '2026-01-03T00:00:00.000Z',
        ],
      );
      await client.query(
        `UPDATE notes
         SET folder = $1, version = 2, deleted_at = $2
         WHERE workspace_id = $3 AND id = $4`,
        ['projects/current', '2026-01-04T00:00:00.000Z', workspaceA, noteA1],
      );
      const authorId = randomUUID();
      await client.query(
        `INSERT INTO note_versions
           (id, note_id, workspace_id, version, title, body_md, tags,
            author_type, author_id, author_name)
         VALUES
           ($1, $2, $3, 1, 'A old', 'old body', '["old"]'::jsonb, 'user', $4, 'Owner'),
           ($5, $2, $3, 2, 'A one', 'current body', '["current"]'::jsonb, 'user', $4, 'Owner'),
           ($6, $7, $3, 1, 'A two', '', '[]'::jsonb, 'user', $4, 'Owner')`,
        [randomUUID(), noteA1, workspaceA, authorId, randomUUID(), randomUUID(), noteA2],
      );

      // This is the supported upgrade path: the ledger baselines a recognized legacy
      // schema instead of replaying shipped migrations, then applies 0003 through 0005.
      await applyMigrationsPglite(client);
      const firstLedger = (
        await client.query(
          `SELECT name, checksum, applied_at::text AS applied_at
           FROM iris_schema_migrations ORDER BY name`,
        )
      ).rows;
      await applyMigrationsPglite(client);
      const secondLedger = (
        await client.query(
          `SELECT name, checksum, applied_at::text AS applied_at
           FROM iris_schema_migrations ORDER BY name`,
        )
      ).rows;
      expect(secondLedger).toEqual(firstLedger);
      expect((secondLedger as Array<{ name: string }>).map((row) => row.name)).toEqual([
        '0001_init.sql',
        '0002_search_and_tags.sql',
        '0003_sync_v2.sql',
        '0004_note_version_organization.sql',
        '0005_note_version_tombstone.sql',
      ]);
      const receiptColumn = (
        await client.query(
          `SELECT data_type, is_nullable, column_default
           FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'sync_idempotency'
             AND column_name = 'receipt_version'`,
        )
      ).rows[0] as {
        data_type: string;
        is_nullable: 'YES' | 'NO';
        column_default: string | null;
      };
      expect(receiptColumn).toEqual({
        data_type: 'smallint',
        is_nullable: 'NO',
        column_default: '1',
      });
      const tombstoneColumn = (
        await client.query(
          `SELECT data_type, is_nullable, column_default
           FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'note_versions'
             AND column_name = 'is_deleted'`,
        )
      ).rows[0] as {
        data_type: string;
        is_nullable: 'YES' | 'NO';
        column_default: string | null;
      };
      expect(tombstoneColumn).toEqual({
        data_type: 'boolean',
        is_nullable: 'YES',
        column_default: null,
      });
      const organizationHistory = (
        await client.query(
          `SELECT version, folder, folder_snapshot_known, is_deleted
           FROM note_versions
           WHERE workspace_id = $1 AND note_id = $2
           ORDER BY version`,
          [workspaceA, noteA1],
        )
      ).rows as Array<{
        version: number;
        folder: string | null;
        folder_snapshot_known: boolean;
        is_deleted: boolean | null;
      }>;
      expect(organizationHistory).toEqual([
        { version: 1, folder: null, folder_snapshot_known: false, is_deleted: null },
        {
          version: 2,
          folder: 'projects/current',
          folder_snapshot_known: true,
          is_deleted: true,
        },
      ]);
      const liveCurrentHead = (
        await client.query(
          `SELECT is_deleted
           FROM note_versions
           WHERE workspace_id = $1 AND note_id = $2 AND version = 1`,
          [workspaceA, noteA2],
        )
      ).rows[0] as { is_deleted: boolean | null };
      expect(liveCurrentHead.is_deleted).toBe(false);

      // An old rolled-back server omitting the 0004/0005 columns stays fail-safe.
      await client.query(
        `INSERT INTO note_versions
           (id, note_id, workspace_id, version, title, body_md, tags,
            author_type, author_id, author_name)
         VALUES ($1, $2, $3, 3, 'Old binary', 'omitted folder', '[]'::jsonb,
                 'user', $4, 'Owner')`,
        [randomUUID(), noteA1, workspaceA, authorId],
      );
      const oldBinary = (
        await client.query(
          `SELECT folder, folder_snapshot_known, is_deleted
           FROM note_versions
           WHERE workspace_id = $1 AND note_id = $2 AND version = 3`,
          [workspaceA, noteA1],
        )
      ).rows[0] as {
        folder: string | null;
        folder_snapshot_known: boolean;
        is_deleted: boolean | null;
      };
      expect(oldBinary).toEqual({
        folder: null,
        folder_snapshot_known: false,
        is_deleted: null,
      });

      const backfilled = (
        await client.query(
          `SELECT id, workspace_id, sync_seq::text AS sync_seq
           FROM notes
           ORDER BY workspace_id, sync_seq`,
        )
      ).rows as Array<{ id: string; workspace_id: string; sync_seq: string }>;
      const aRows = backfilled.filter((row) => row.workspace_id === workspaceA);
      const bRows = backfilled.filter((row) => row.workspace_id === workspaceB);
      expect(aRows).toEqual([
        { id: noteA1, workspace_id: workspaceA, sync_seq: '1' },
        { id: noteA2, workspace_id: workspaceA, sync_seq: '2' },
      ]);
      expect(bRows).toEqual([{ id: noteB1, workspace_id: workspaceB, sync_seq: '1' }]);

      const counters = (
        await client.query(
          `SELECT workspace_id, last_seq::text AS last_seq
           FROM workspace_sync_cursors
           ORDER BY workspace_id`,
        )
      ).rows as Array<{ workspace_id: string; last_seq: string }>;
      expect(counters.find((row) => row.workspace_id === workspaceA)?.last_seq).toBe('2');
      expect(counters.find((row) => row.workspace_id === workspaceB)?.last_seq).toBe('1');

      await client.query(`SELECT set_config('app.current_workspace', $1, false)`, [workspaceA]);
      const noteA3 = randomUUID();
      await client.query('INSERT INTO notes (id, workspace_id, title) VALUES ($1, $2, $3)', [
        noteA3,
        workspaceA,
        'A three',
      ]);
      await client.query('UPDATE notes SET title = $1 WHERE id = $2 AND workspace_id = $3', [
        'A three updated',
        noteA3,
        workspaceA,
      ]);

      const continued = (
        await client.query(
          `SELECT n.sync_seq::text AS sync_seq, c.last_seq::text AS last_seq
           FROM notes AS n
           JOIN workspace_sync_cursors AS c ON c.workspace_id = n.workspace_id
           WHERE n.id = $1`,
          [noteA3],
        )
      ).rows[0] as { sync_seq: string; last_seq: string };
      expect(continued).toEqual({ sync_seq: '4', last_seq: '4' });
    } finally {
      await client.close();
    }
  });

  it('backfills identical note ids independently across workspaces', async () => {
    const client = new PGlite();
    try {
      const migrations = migrationSql();
      const tombstone = migrations.find(
        (migration) => migration.name === '0005_note_version_tombstone.sql',
      );
      expect(tombstone).toBeDefined();
      for (const migration of migrations.filter(
        (item) => item.name < '0005_note_version_tombstone.sql',
      )) {
        await client.exec(migration.sql);
      }

      const workspaceA = randomUUID();
      const workspaceB = randomUUID();
      const sharedNoteId = randomUUID();
      const authorId = randomUUID();
      await client.query('INSERT INTO workspaces (id, name) VALUES ($1, $2), ($3, $4)', [
        workspaceA,
        'Workspace A',
        workspaceB,
        'Workspace B',
      ]);

      await client.query(`SELECT set_config('app.current_workspace', $1, false)`, [workspaceA]);
      await client.query(
        `INSERT INTO notes (id, workspace_id, title)
         VALUES ($1, $2, 'Live note')`,
        [sharedNoteId, workspaceA],
      );
      await client.query(
        `INSERT INTO note_versions
           (id, note_id, workspace_id, version, title, body_md, tags,
            author_type, author_id, author_name)
         VALUES ($1, $2, $3, 1, 'Live note', '', '[]'::jsonb, 'user', $4, 'Owner')`,
        [randomUUID(), sharedNoteId, workspaceA, authorId],
      );

      await client.query(`SELECT set_config('app.current_workspace', $1, false)`, [workspaceB]);
      await client.query(
        `INSERT INTO notes (id, workspace_id, title, deleted_at)
         VALUES ($1, $2, 'Deleted note', $3)`,
        [sharedNoteId, workspaceB, '2026-07-16T12:00:00.000Z'],
      );
      await client.query(
        `INSERT INTO note_versions
           (id, note_id, workspace_id, version, title, body_md, tags,
            author_type, author_id, author_name)
         VALUES ($1, $2, $3, 1, 'Deleted note', '', '[]'::jsonb, 'user', $4, 'Owner')`,
        [randomUUID(), sharedNoteId, workspaceB, authorId],
      );

      await client.exec(tombstone!.sql);

      const states = (
        await client.query(
          `SELECT workspace_id, is_deleted
           FROM note_versions
           WHERE note_id = $1
           ORDER BY workspace_id`,
          [sharedNoteId],
        )
      ).rows as Array<{ workspace_id: string; is_deleted: boolean | null }>;
      expect(states).toHaveLength(2);
      expect(states.find((row) => row.workspace_id === workspaceA)?.is_deleted).toBe(false);
      expect(states.find((row) => row.workspace_id === workspaceB)?.is_deleted).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('rolls back the tombstone artifact, receipt, and RLS suspension on backfill failure', async () => {
    const client = new PGlite();
    try {
      await applyMigrationsPglite(client);
      const workspaceId = randomUUID();
      const noteId = randomUUID();
      await client.query('INSERT INTO workspaces (id, name) VALUES ($1, $2)', [
        workspaceId,
        'Rollback workspace',
      ]);
      await client.query(`SELECT set_config('app.current_workspace', $1, false)`, [workspaceId]);
      await client.query('INSERT INTO notes (id, workspace_id, title) VALUES ($1, $2, $3)', [
        noteId,
        workspaceId,
        'Rollback note',
      ]);
      await client.query(
        `INSERT INTO note_versions
           (id, note_id, workspace_id, version, title, body_md, tags,
            author_type, author_id, author_name)
         VALUES ($1, $2, $3, 1, 'Rollback note', '', '[]'::jsonb,
                 'user', $4, 'Owner')`,
        [randomUUID(), noteId, workspaceId, randomUUID()],
      );
      await client.exec(`
        DELETE FROM iris_schema_migrations
        WHERE name = '0005_note_version_tombstone.sql';
        ALTER TABLE note_versions DROP COLUMN is_deleted;
        CREATE FUNCTION reject_tombstone_backfill() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'forced tombstone backfill failure';
        END
        $$;
        CREATE TRIGGER reject_tombstone_backfill
        BEFORE UPDATE ON note_versions
        FOR EACH ROW EXECUTE FUNCTION reject_tombstone_backfill()
      `);

      await expect(applyMigrationsPglite(client)).rejects.toThrow(
        'forced tombstone backfill failure',
      );

      const column = (
        await client.query(
          `SELECT EXISTS (
             SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema()
               AND table_name = 'note_versions'
               AND column_name = 'is_deleted'
           ) AS present`,
        )
      ).rows[0] as { present: boolean };
      expect(column.present).toBe(false);
      const receipt = (
        await client.query(
          `SELECT count(*)::text AS count FROM iris_schema_migrations
           WHERE name = '0005_note_version_tombstone.sql'`,
        )
      ).rows[0] as { count: string };
      expect(receipt.count).toBe('0');
      const rls = (
        await client.query(
          `SELECT relname AS table_name,
                  relrowsecurity AS enabled,
                  relforcerowsecurity AS forced
           FROM pg_class
           WHERE oid IN (to_regclass('public.notes'), to_regclass('public.note_versions'))
           ORDER BY relname`,
        )
      ).rows as Array<{ table_name: string; enabled: boolean; forced: boolean }>;
      expect(rls).toEqual([
        { table_name: 'note_versions', enabled: true, forced: true },
        { table_name: 'notes', enabled: true, forced: true },
      ]);
    } finally {
      await client.close();
    }
  });

  it('serializes concurrent fresh runs and rejects checksum drift', async () => {
    const client = new PGlite();
    try {
      await Promise.all([applyMigrationsPglite(client), applyMigrationsPglite(client)]);
      const ledger = (await client.query('SELECT name FROM iris_schema_migrations ORDER BY name'))
        .rows as Array<{ name: string }>;
      expect(ledger.map((row) => row.name)).toEqual([
        '0001_init.sql',
        '0002_search_and_tags.sql',
        '0003_sync_v2.sql',
        '0004_note_version_organization.sql',
        '0005_note_version_tombstone.sql',
      ]);

      await client.query(
        `UPDATE iris_schema_migrations SET checksum = 'tampered' WHERE name = '0001_init.sql'`,
      );
      await expect(applyMigrationsPglite(client)).rejects.toThrow(
        'Database migration checksum mismatch for 0001_init.sql',
      );
    } finally {
      await client.close();
    }
  });

  it('upgrades an exact 0001 legacy database without replaying it', async () => {
    const client = new PGlite();
    try {
      const initial = migrationSql().find((migration) => migration.name === '0001_init.sql');
      expect(initial).toBeDefined();
      await client.exec(initial!.sql);

      const workspaceId = randomUUID();
      const noteId = randomUUID();
      await client.query('INSERT INTO workspaces (id, name) VALUES ($1, $2)', [
        workspaceId,
        'Legacy workspace',
      ]);
      await client.query('INSERT INTO notes (id, workspace_id, title) VALUES ($1, $2, $3)', [
        noteId,
        workspaceId,
        'Legacy note',
      ]);

      await applyMigrationsPglite(client);

      const upgraded = (
        await client.query(`SELECT tags, sync_seq::text AS sync_seq FROM notes WHERE id = $1`, [
          noteId,
        ])
      ).rows[0] as { tags: string[]; sync_seq: string };
      expect(upgraded).toEqual({ tags: [], sync_seq: '1' });
      const ledger = (await client.query('SELECT name FROM iris_schema_migrations ORDER BY name'))
        .rows as Array<{ name: string }>;
      expect(ledger.map((row) => row.name)).toEqual([
        '0001_init.sql',
        '0002_search_and_tags.sql',
        '0003_sync_v2.sql',
        '0004_note_version_organization.sql',
        '0005_note_version_tombstone.sql',
      ]);
    } finally {
      await client.close();
    }
  });

  it('fails loud on partial or RLS-drifted legacy schemas', async () => {
    const partial = new PGlite();
    try {
      await partial.exec('CREATE TABLE workspaces (id uuid PRIMARY KEY)');
      await expect(applyMigrationsPglite(partial)).rejects.toThrow(
        'partial or unrecognized 0001_init.sql schema',
      );
    } finally {
      await partial.close();
    }

    const drifted = new PGlite();
    try {
      for (const migration of migrationSql().filter((item) => item.name < '0003_sync_v2.sql')) {
        await drifted.exec(migration.sql);
      }
      await drifted.exec('ALTER TABLE notes NO FORCE ROW LEVEL SECURITY');
      await expect(applyMigrationsPglite(drifted)).rejects.toThrow(
        'partial or unrecognized 0001_init.sql schema',
      );
    } finally {
      await drifted.close();
    }

    const constraintDrifted = new PGlite();
    try {
      for (const migration of migrationSql().filter((item) => item.name < '0003_sync_v2.sql')) {
        await constraintDrifted.exec(migration.sql);
      }
      await constraintDrifted.exec('ALTER TABLE users DROP CONSTRAINT users_email_key');
      await expect(applyMigrationsPglite(constraintDrifted)).rejects.toThrow(
        'partial or unrecognized 0001_init.sql schema',
      );
    } finally {
      await constraintDrifted.close();
    }

    const unledgered = new PGlite();
    try {
      for (const migration of migrationSql().filter((item) => item.name < '0003_sync_v2.sql')) {
        await unledgered.exec(migration.sql);
      }
      await unledgered.exec('ALTER TABLE notes ADD COLUMN sync_seq bigint');
      await expect(applyMigrationsPglite(unledgered)).rejects.toThrow(
        'Database contains unledgered 0003_sync_v2.sql artifacts',
      );
    } finally {
      await unledgered.close();
    }
  });

  it('rejects a malformed partial 0002 schema instead of treating it as absent', async () => {
    const client = new PGlite();
    try {
      const initial = migrationSql().find((migration) => migration.name === '0001_init.sql');
      expect(initial).toBeDefined();
      await client.exec(initial!.sql);
      await client.exec('ALTER TABLE notes ADD COLUMN tags text');

      await expect(applyMigrationsPglite(client)).rejects.toThrow(
        'partial or unrecognized 0002_search_and_tags.sql schema',
      );
    } finally {
      await client.close();
    }
  });

  it('rejects partial 0003 artifacts without a receipt in a nonempty ledger', async () => {
    const client = new PGlite();
    try {
      await applyMigrationsPglite(client);
      await client.exec(`
        DELETE FROM iris_schema_migrations
        WHERE name IN (
          '0003_sync_v2.sql',
          '0004_note_version_organization.sql',
          '0005_note_version_tombstone.sql'
        );
        DROP TRIGGER notes_sync_seq_assign ON notes;
      `);

      await expect(applyMigrationsPglite(client)).rejects.toThrow(
        'Database contains unledgered 0003_sync_v2.sql artifacts',
      );
    } finally {
      await client.close();
    }
  });

  it('rejects unledgered 0004 artifacts in a nonempty ledger', async () => {
    const client = new PGlite();
    try {
      await applyMigrationsPglite(client);
      await client.exec(`
        DELETE FROM iris_schema_migrations
        WHERE name IN (
          '0004_note_version_organization.sql',
          '0005_note_version_tombstone.sql'
        )
      `);

      await expect(applyMigrationsPglite(client)).rejects.toThrow(
        'Database contains unledgered 0004_note_version_organization.sql artifacts',
      );
    } finally {
      await client.close();
    }
  });

  it('rejects unledgered 0005 artifacts in a nonempty ledger', async () => {
    const client = new PGlite();
    try {
      await applyMigrationsPglite(client);
      await client.exec(
        `DELETE FROM iris_schema_migrations WHERE name = '0005_note_version_tombstone.sql'`,
      );

      await expect(applyMigrationsPglite(client)).rejects.toThrow(
        'Database contains unledgered 0005_note_version_tombstone.sql artifacts',
      );
    } finally {
      await client.close();
    }
  });

  it('rejects a malformed partial 0005 artifact without a receipt', async () => {
    const client = new PGlite();
    try {
      await applyMigrationsPglite(client);
      await client.exec(`
        DELETE FROM iris_schema_migrations
        WHERE name = '0005_note_version_tombstone.sql';
        ALTER TABLE note_versions
          ALTER COLUMN is_deleted TYPE text USING is_deleted::text
      `);

      await expect(applyMigrationsPglite(client)).rejects.toThrow(
        'Database contains unledgered 0005_note_version_tombstone.sql artifacts',
      );
    } finally {
      await client.close();
    }
  });

  it.each([
    {
      kind: 'dropped receipt primary key',
      sql: 'ALTER TABLE sync_idempotency DROP CONSTRAINT sync_idempotency_pkey',
      artifact: 'constraint sync_idempotency.sync_idempotency_pkey missing',
    },
    {
      kind: 'redefined receipt primary key',
      sql: `
        ALTER TABLE sync_idempotency DROP CONSTRAINT sync_idempotency_pkey;
        ALTER TABLE sync_idempotency
          ADD CONSTRAINT sync_idempotency_pkey PRIMARY KEY (op_id);
      `,
      artifact: 'constraint sync_idempotency.sync_idempotency_pkey drifted',
    },
    {
      kind: 'expanded note sequence index',
      sql: `
        DROP INDEX notes_sync_idx;
        CREATE UNIQUE INDEX notes_sync_idx
          ON notes (workspace_id, sync_seq, id);
      `,
      artifact: 'index definition notes_sync_idx drifted',
    },
    {
      kind: 'weakened cursor check',
      sql: `
        ALTER TABLE workspace_sync_cursors
          DROP CONSTRAINT workspace_sync_cursors_last_seq_check;
        ALTER TABLE workspace_sync_cursors
          ADD CONSTRAINT workspace_sync_cursors_last_seq_check CHECK (last_seq >= -1);
      `,
      artifact: 'constraint workspace_sync_cursors.workspace_sync_cursors_last_seq_check drifted',
    },
    {
      kind: 'dropped sequence trigger',
      sql: 'DROP TRIGGER notes_sync_seq_assign ON notes',
      artifact: 'trigger notes.notes_sync_seq_assign missing',
    },
    {
      kind: 'disabled sequence trigger',
      sql: 'ALTER TABLE notes DISABLE TRIGGER notes_sync_seq_assign',
      artifact: 'trigger notes.notes_sync_seq_assign drifted',
    },
    {
      kind: 'retargeted sequence trigger',
      sql: `
        DROP TRIGGER notes_sync_seq_assign ON notes;
        CREATE TRIGGER notes_sync_seq_assign
          BEFORE INSERT OR UPDATE ON notes
          FOR EACH ROW
          EXECUTE FUNCTION iris_lock_workspace_sync_cursor();
      `,
      artifact: 'trigger notes.notes_sync_seq_assign drifted',
    },
    {
      kind: 'disabled notes RLS',
      sql: 'ALTER TABLE notes DISABLE ROW LEVEL SECURITY',
      artifact: 'RLS policy notes.workspace_isolation drifted',
    },
    {
      kind: 'rewritten sequence function',
      sql: `
        CREATE OR REPLACE FUNCTION iris_assign_note_sync_seq()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RETURN NEW;
        END $$;
      `,
      artifact: 'function iris_assign_note_sync_seq drifted',
    },
    {
      kind: 'additively weakened sequence function',
      sql: `
        CREATE OR REPLACE FUNCTION iris_assign_note_sync_seq()
        RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE
          current_workspace uuid :=
            NULLIF(current_setting('app.current_workspace', true), '')::uuid;
        BEGIN
          IF current_workspace IS NULL THEN
            RETURN NEW;
          END IF;
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
      `,
      artifact: 'function iris_assign_note_sync_seq drifted',
    },
  ])('rejects $kind after the additive 0005 migration', async ({ sql, artifact }) => {
    const client = new PGlite();
    try {
      await applyMigrationsPglite(client);
      await client.exec(sql);

      await expect(applyMigrationsPglite(client)).rejects.toThrow(artifact);
    } finally {
      await client.close();
    }
  });

  it.each([
    {
      kind: 'dropped folder snapshot column',
      sql: 'ALTER TABLE note_versions DROP COLUMN folder',
      artifact: 'column definition note_versions.folder missing',
    },
    {
      kind: 'changed folder-known default',
      sql: 'ALTER TABLE note_versions ALTER COLUMN folder_snapshot_known SET DEFAULT true',
      artifact: 'column definition note_versions.folder_snapshot_known drifted',
    },
    {
      kind: 'changed folder column type',
      sql: 'ALTER TABLE note_versions ALTER COLUMN folder TYPE varchar(255)',
      artifact: 'column definition note_versions.folder drifted',
    },
  ])('rejects 0004 $kind', async ({ sql, artifact }) => {
    const client = new PGlite();
    try {
      await applyMigrationsPglite(client);
      await client.exec(sql);

      await expect(applyMigrationsPglite(client)).rejects.toThrow(artifact);
    } finally {
      await client.close();
    }
  });

  it.each([
    {
      kind: 'dropped tombstone-state column',
      sql: 'ALTER TABLE note_versions DROP COLUMN is_deleted',
      artifact: 'column definition note_versions.is_deleted missing',
    },
    {
      kind: 'manufactured live-state default',
      sql: 'ALTER TABLE note_versions ALTER COLUMN is_deleted SET DEFAULT false',
      artifact: 'column definition note_versions.is_deleted drifted',
    },
    {
      kind: 'lost legacy unknown state',
      sql: 'ALTER TABLE note_versions ALTER COLUMN is_deleted SET NOT NULL',
      artifact: 'column definition note_versions.is_deleted drifted',
    },
    {
      kind: 'changed tombstone-state type',
      sql: 'ALTER TABLE note_versions ALTER COLUMN is_deleted TYPE text USING is_deleted::text',
      artifact: 'column definition note_versions.is_deleted drifted',
    },
  ])('rejects 0005 $kind', async ({ sql, artifact }) => {
    const client = new PGlite();
    try {
      await applyMigrationsPglite(client);
      await client.exec(sql);

      await expect(applyMigrationsPglite(client)).rejects.toThrow(artifact);
    } finally {
      await client.close();
    }
  });

  it('projects pg_policies roles as text[] for database-driver parsing', async () => {
    const client = new PGlite();
    try {
      const initial = migrationSql().find((migration) => migration.name === '0001_init.sql');
      expect(initial).toBeDefined();
      await client.exec(initial!.sql);

      const projection = (
        await client.query(
          `SELECT pg_typeof(policy.roles)::text AS source_type,
                  pg_typeof(policy.roles::text[])::text AS projected_type,
                  policy.roles::text[] AS roles
           FROM pg_policies AS policy
           WHERE policy.schemaname = current_schema()
             AND policy.tablename = 'notes'
             AND policy.policyname = 'workspace_isolation'`,
        )
      ).rows[0] as { source_type: string; projected_type: string; roles: string[] };
      expect(projection).toEqual({
        source_type: 'name[]',
        projected_type: 'text[]',
        roles: ['public'],
      });
    } finally {
      await client.close();
    }
  });

  it.each([
    {
      kind: 'expression',
      setup: '',
      policy: `CREATE POLICY workspace_isolation ON notes
        USING (true OR workspace_id = current_setting('app.current_workspace', true)::uuid)
        WITH CHECK (workspace_id = current_setting('app.current_workspace', true)::uuid)`,
    },
    {
      kind: 'WITH CHECK expression',
      setup: '',
      policy: `CREATE POLICY workspace_isolation ON notes
        USING (workspace_id = current_setting('app.current_workspace', true)::uuid)
        WITH CHECK (true OR workspace_id = current_setting('app.current_workspace', true)::uuid)`,
    },
    {
      kind: 'permissiveness',
      setup: '',
      policy: `CREATE POLICY workspace_isolation ON notes AS RESTRICTIVE
        USING (workspace_id = current_setting('app.current_workspace', true)::uuid)
        WITH CHECK (workspace_id = current_setting('app.current_workspace', true)::uuid)`,
    },
    {
      kind: 'command',
      setup: '',
      policy: `CREATE POLICY workspace_isolation ON notes FOR SELECT
        USING (workspace_id = current_setting('app.current_workspace', true)::uuid)`,
    },
    {
      kind: 'role',
      setup: 'CREATE ROLE iris_policy_reader NOLOGIN',
      policy: `CREATE POLICY workspace_isolation ON notes TO iris_policy_reader
        USING (workspace_id = current_setting('app.current_workspace', true)::uuid)
        WITH CHECK (workspace_id = current_setting('app.current_workspace', true)::uuid)`,
    },
  ])('rejects $kind drift in legacy RLS policies', async ({ setup, policy }) => {
    const client = new PGlite();
    try {
      for (const migration of migrationSql().filter((item) => item.name < '0003_sync_v2.sql')) {
        await client.exec(migration.sql);
      }
      await client.exec('DROP POLICY workspace_isolation ON notes');
      if (setup) await client.exec(setup);
      await client.exec(policy);

      await expect(applyMigrationsPglite(client)).rejects.toThrow(
        'partial or unrecognized 0001_init.sql schema',
      );
    } finally {
      await client.close();
    }
  });

  it('rejects extra permissive policies alongside the canonical policy', async () => {
    const client = new PGlite();
    try {
      for (const migration of migrationSql().filter((item) => item.name < '0003_sync_v2.sql')) {
        await client.exec(migration.sql);
      }
      await client.exec(`
        CREATE POLICY allow_all ON notes
          USING (true)
          WITH CHECK (true)
      `);

      await expect(applyMigrationsPglite(client)).rejects.toThrow(
        'partial or unrecognized 0001_init.sql schema',
      );
    } finally {
      await client.close();
    }
  });

  it('rejects nullable material columns in a legacy baseline', async () => {
    const client = new PGlite();
    try {
      for (const migration of migrationSql().filter((item) => item.name < '0003_sync_v2.sql')) {
        await client.exec(migration.sql);
      }
      await client.exec('ALTER TABLE users ALTER COLUMN email DROP NOT NULL');

      await expect(applyMigrationsPglite(client)).rejects.toThrow(
        'partial or unrecognized 0001_init.sql schema',
      );
    } finally {
      await client.close();
    }
  });

  it.each([
    { table: 'users', clause: 'ENABLE ROW LEVEL SECURITY' },
    { table: 'users', clause: 'FORCE ROW LEVEL SECURITY' },
    { table: 'agent_tokens', clause: 'ENABLE ROW LEVEL SECURITY' },
    { table: 'agent_tokens', clause: 'FORCE ROW LEVEL SECURITY' },
  ])('rejects unexpected $clause on legacy $table', async ({ table, clause }) => {
    const client = new PGlite();
    try {
      for (const migration of migrationSql().filter((item) => item.name < '0003_sync_v2.sql')) {
        await client.exec(migration.sql);
      }
      await client.exec(`ALTER TABLE ${table} ${clause}`);

      await expect(applyMigrationsPglite(client)).rejects.toThrow(
        'partial or unrecognized 0001_init.sql schema',
      );
    } finally {
      await client.close();
    }
  });

  it('upgrades legacy notes as a non-BYPASSRLS migration role', async () => {
    const client = new PGlite();
    let roleSet = false;
    try {
      for (const migration of migrationSql().filter((item) => item.name < '0003_sync_v2.sql')) {
        await client.exec(migration.sql);
      }
      const workspaceId = randomUUID();
      const noteId = randomUUID();
      await client.query('INSERT INTO workspaces (id, name) VALUES ($1, $2)', [
        workspaceId,
        'RLS workspace',
      ]);
      await client.query(
        `INSERT INTO notes (id, workspace_id, title, folder, deleted_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [noteId, workspaceId, 'RLS legacy note', 'rls/folder', '2026-01-05T00:00:00.000Z'],
      );
      await client.query(
        `INSERT INTO note_versions
           (id, note_id, workspace_id, version, title, body_md, tags,
            author_type, author_id, author_name)
         VALUES ($1, $2, $3, 1, 'RLS legacy note', '', '[]'::jsonb,
                 'user', $4, 'Owner')`,
        [randomUUID(), noteId, workspaceId, randomUUID()],
      );

      await client.exec(`
        CREATE ROLE iris_migrator NOLOGIN;
        GRANT USAGE, CREATE ON SCHEMA public TO iris_migrator;
        GRANT SELECT ON ALL TABLES IN SCHEMA public TO iris_migrator;
        GRANT REFERENCES ON TABLE workspaces TO iris_migrator;
        ALTER TABLE notes OWNER TO iris_migrator;
        ALTER TABLE note_versions OWNER TO iris_migrator;
        ALTER TABLE devices OWNER TO iris_migrator;
        SET ROLE iris_migrator;
      `);
      roleSet = true;
      await applyMigrationsPglite(client);
      await client.exec('RESET ROLE');
      roleSet = false;

      const role = (
        await client.query(
          `SELECT rolbypassrls AS bypasses_rls FROM pg_roles WHERE rolname = 'iris_migrator'`,
        )
      ).rows[0] as { bypasses_rls: boolean };
      expect(role.bypasses_rls).toBe(false);
      const note = (
        await client.query('SELECT sync_seq::text AS sync_seq FROM notes WHERE id = $1', [noteId])
      ).rows[0] as { sync_seq: string };
      expect(note.sync_seq).toBe('1');
      const version = (
        await client.query(
          `SELECT folder, folder_snapshot_known, is_deleted
           FROM note_versions
           WHERE workspace_id = $1 AND note_id = $2 AND version = 1`,
          [workspaceId, noteId],
        )
      ).rows[0] as {
        folder: string | null;
        folder_snapshot_known: boolean;
        is_deleted: boolean | null;
      };
      expect(version).toEqual({
        folder: 'rls/folder',
        folder_snapshot_known: true,
        is_deleted: true,
      });
      const rls = (
        await client.query(
          `SELECT relname AS table_name,
                  relrowsecurity AS enabled,
                  relforcerowsecurity AS forced
           FROM pg_class
           WHERE oid IN (
             to_regclass('public.notes'),
             to_regclass('public.note_versions')
           )
           ORDER BY relname`,
        )
      ).rows as Array<{ table_name: string; enabled: boolean; forced: boolean }>;
      expect(rls).toEqual([
        { table_name: 'note_versions', enabled: true, forced: true },
        { table_name: 'notes', enabled: true, forced: true },
      ]);
    } finally {
      if (roleSet) await client.exec('RESET ROLE');
      await client.close();
    }
  });
});
