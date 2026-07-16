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
      expect(syncV2).toBeDefined();
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

      // This is the supported upgrade path: the ledger baselines a recognized legacy
      // schema instead of replaying shipped migrations, then applies only 0003.
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
        DELETE FROM iris_schema_migrations WHERE name = '0003_sync_v2.sql';
        DROP TRIGGER notes_sync_seq_assign ON notes;
      `);

      await expect(applyMigrationsPglite(client)).rejects.toThrow(
        'Database contains unledgered 0003_sync_v2.sql artifacts',
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
  ])('rejects $kind while 0003 is the migration head', async ({ sql, artifact }) => {
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
      await client.query('INSERT INTO notes (id, workspace_id, title) VALUES ($1, $2, $3)', [
        noteId,
        workspaceId,
        'RLS legacy note',
      ]);

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
      const rls = (
        await client.query(
          `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
           FROM pg_class
           WHERE oid = to_regclass('public.notes')`,
        )
      ).rows[0] as { enabled: boolean; forced: boolean };
      expect(rls).toEqual({ enabled: true, forced: true });
    } finally {
      if (roleSet) await client.exec('RESET ROLE');
      await client.close();
    }
  });
});
