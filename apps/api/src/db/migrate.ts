/**
 * Migration runner. Applies each pending `migrations/*.sql` file once, in filename
 * order, as a whole (their `DO $$ … $$` blocks must not be split on `;`).
 *
 * Used by the test harness (against a fresh PGlite) and by `pnpm db:migrate`
 * (against PGlite or a real cluster).
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { env } from '../env';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));
const MIGRATION_LOCK_A = 0x4952; // "IR"
const MIGRATION_LOCK_B = 0x4953; // "IS"

interface QueryClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}

interface LegacyColumnDefinition {
  table: string;
  column: string;
  dataType: string;
  nullable: boolean;
  defaultExpression?: string;
  generated?: boolean;
  generationIncludes?: string[];
}

interface LegacyPolicyDefinition {
  table: string;
  name: string;
  permissive: 'PERMISSIVE' | 'RESTRICTIVE';
  roles: string[];
  command: 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
  usingExpression: string | null;
  checkExpression: string | null;
  preexisting?: boolean;
}

interface LegacyRlsDefinition {
  table: string;
  enabled: boolean;
  forced: boolean;
}

interface LegacySignature {
  name: string;
  checksum?: string;
  tables?: string[];
  columns?: Array<[table: string, column: string]>;
  tableDefinitions?: Array<{
    table: string;
    columns: string[];
    preexisting?: boolean;
  }>;
  columnDefinitions?: LegacyColumnDefinition[];
  indexes?: string[];
  indexDefinitions?: Array<{
    name: string;
    includes: string[];
    predecessorIncludes?: string[];
    table?: string;
    unique?: boolean;
    definitionSuffix?: string;
    predecessorUnique?: boolean;
    predecessorDefinitionSuffix?: string;
  }>;
  constraints?: Array<{
    table: string;
    name: string;
    type: 'p' | 'u' | 'f' | 'c';
    includes: string[];
    predecessorIncludes?: string[];
    definition?: string;
    predecessorDefinition?: string;
  }>;
  policies?: LegacyPolicyDefinition[];
  rls?: LegacyRlsDefinition[];
  triggers?: Array<{
    table: string;
    name: string;
    enabled: 'O' | 'D' | 'R' | 'A';
    timing: 'BEFORE' | 'AFTER' | 'INSTEAD OF';
    events: Array<'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE'>;
    orientation: 'ROW' | 'STATEMENT';
    functionName: string;
  }>;
  functions?: Array<{
    name: string;
    language: string;
    returnType: string;
    volatility: 'i' | 's' | 'v';
    securityDefiner: boolean;
    body: string;
  }>;
}

interface ArtifactState {
  present: boolean;
  matches: boolean;
  evidence: boolean;
}

type ColumnShape = [
  column: string,
  dataType: string,
  nullable: boolean,
  defaultExpression?: string,
];

const defineColumns = (table: string, shapes: ColumnShape[]): LegacyColumnDefinition[] =>
  shapes.map(([column, dataType, nullable, defaultExpression]) => ({
    table,
    column,
    dataType,
    nullable,
    ...(defaultExpression === undefined ? {} : { defaultExpression }),
  }));

// Canonical pg_policies/pg_get_expr rendering of the expression shipped in 0001.
const WORKSPACE_POLICY_EXPRESSION = `(workspace_id = (current_setting('app.current_workspace'::text, true))::uuid)`;

const workspaceIsolationPolicy = (table: string, preexisting = false): LegacyPolicyDefinition => ({
  table,
  name: 'workspace_isolation',
  permissive: 'PERMISSIVE',
  roles: ['public'],
  command: 'ALL',
  usingExpression: WORKSPACE_POLICY_EXPRESSION,
  checkExpression: WORKSPACE_POLICY_EXPRESSION,
  preexisting,
});

/**
 * Databases created before the migration ledger shipped need a one-time, fail-loud
 * baseline. These are postcondition signatures, not guesses based on a single table.
 */
const LEGACY_SIGNATURES: LegacySignature[] = [
  {
    name: '0001_init.sql',
    checksum: '5a71561a6353b24709ebb428f39c1b2e6a2d2e683f546c263ad5feffe6bb0930',
    tables: [
      'workspaces',
      'users',
      'workspace_members',
      'notes',
      'note_versions',
      'agent_tokens',
      'activity_log',
      'devices',
      'subscriptions',
    ],
    columnDefinitions: [
      ...defineColumns('workspaces', [
        ['id', 'uuid', false],
        ['name', 'text', false],
        ['created_at', 'timestamp with time zone', false, 'now()'],
      ]),
      ...defineColumns('users', [
        ['id', 'uuid', false],
        ['email', 'text', false],
        ['display_name', 'text', false],
        ['password_hash', 'text', true],
        ['created_at', 'timestamp with time zone', false, 'now()'],
      ]),
      ...defineColumns('workspace_members', [
        ['id', 'uuid', false],
        ['workspace_id', 'uuid', false],
        ['user_id', 'uuid', false],
        ['role', 'text', false, `'owner'::text`],
        ['created_at', 'timestamp with time zone', false, 'now()'],
      ]),
      ...defineColumns('notes', [
        ['id', 'uuid', false],
        ['workspace_id', 'uuid', false],
        ['title', 'text', false, `''::text`],
        ['body_md', 'text', false, `''::text`],
        ['folder', 'text', true],
        ['version', 'integer', false, '1'],
        ['created_at', 'timestamp with time zone', false, 'now()'],
        ['updated_at', 'timestamp with time zone', false, 'now()'],
        ['deleted_at', 'timestamp with time zone', true],
      ]),
      ...defineColumns('note_versions', [
        ['id', 'uuid', false],
        ['note_id', 'uuid', false],
        ['workspace_id', 'uuid', false],
        ['version', 'integer', false],
        ['title', 'text', false],
        ['body_md', 'text', false],
        ['author_type', 'text', false],
        ['author_id', 'uuid', false],
        ['author_name', 'text', false],
        ['created_at', 'timestamp with time zone', false, 'now()'],
      ]),
      ...defineColumns('agent_tokens', [
        ['id', 'uuid', false],
        ['workspace_id', 'uuid', false],
        ['agent_name', 'text', false],
        ['token_hash', 'text', false],
        ['token_prefix', 'text', false],
        ['scopes', 'jsonb', false],
        ['created_at', 'timestamp with time zone', false, 'now()'],
        ['last_used_at', 'timestamp with time zone', true],
        ['revoked_at', 'timestamp with time zone', true],
      ]),
      ...defineColumns('activity_log', [
        ['id', 'uuid', false],
        ['workspace_id', 'uuid', false],
        ['actor_type', 'text', false],
        ['actor_id', 'uuid', false],
        ['actor_name', 'text', false],
        ['action', 'text', false],
        ['note_id', 'uuid', true],
        ['note_version_id', 'uuid', true],
        ['resulting_version', 'integer', true],
        ['undo_of_id', 'uuid', true],
        ['created_at', 'timestamp with time zone', false, 'now()'],
      ]),
      ...defineColumns('devices', [
        ['id', 'text', false],
        ['workspace_id', 'uuid', false],
        ['name', 'text', false],
        ['platform', 'text', false],
        ['created_at', 'timestamp with time zone', false, 'now()'],
        ['last_seen_at', 'timestamp with time zone', false, 'now()'],
      ]),
      ...defineColumns('subscriptions', [
        ['workspace_id', 'uuid', false],
        ['plan', 'text', false, `'free'::text`],
        ['status', 'text', false, `'none'::text`],
        ['stripe_customer_id', 'text', true],
        ['stripe_subscription_id', 'text', true],
        ['current_period_end', 'timestamp with time zone', true],
        ['updated_at', 'timestamp with time zone', false, 'now()'],
      ]),
    ],
    indexes: [
      'workspace_members_unique',
      'notes_sync_idx',
      'note_versions_unique',
      'activity_feed_idx',
    ],
    indexDefinitions: [
      {
        name: 'workspace_members_unique',
        includes: ['UNIQUE INDEX', 'workspace_id', 'user_id'],
      },
      { name: 'notes_sync_idx', includes: ['INDEX', 'workspace_id', 'updated_at', 'id'] },
      { name: 'note_versions_unique', includes: ['UNIQUE INDEX', 'note_id', 'version'] },
      { name: 'activity_feed_idx', includes: ['INDEX', 'workspace_id', 'created_at'] },
    ],
    constraints: [
      { table: 'workspaces', name: 'workspaces_pkey', type: 'p', includes: ['PRIMARY KEY', 'id'] },
      { table: 'users', name: 'users_pkey', type: 'p', includes: ['PRIMARY KEY', 'id'] },
      { table: 'users', name: 'users_email_key', type: 'u', includes: ['UNIQUE', 'email'] },
      {
        table: 'workspace_members',
        name: 'workspace_members_pkey',
        type: 'p',
        includes: ['PRIMARY KEY', 'id'],
      },
      {
        table: 'workspace_members',
        name: 'workspace_members_workspace_id_fkey',
        type: 'f',
        includes: ['FOREIGN KEY', 'workspace_id', 'workspaces', 'ON DELETE CASCADE'],
      },
      {
        table: 'workspace_members',
        name: 'workspace_members_user_id_fkey',
        type: 'f',
        includes: ['FOREIGN KEY', 'user_id', 'users', 'ON DELETE CASCADE'],
      },
      { table: 'notes', name: 'notes_pkey', type: 'p', includes: ['PRIMARY KEY', 'id'] },
      {
        table: 'notes',
        name: 'notes_workspace_id_fkey',
        type: 'f',
        includes: ['FOREIGN KEY', 'workspace_id', 'workspaces', 'ON DELETE CASCADE'],
      },
      {
        table: 'note_versions',
        name: 'note_versions_pkey',
        type: 'p',
        includes: ['PRIMARY KEY', 'id'],
      },
      {
        table: 'note_versions',
        name: 'note_versions_note_id_fkey',
        type: 'f',
        includes: ['FOREIGN KEY', 'note_id', 'notes', 'ON DELETE CASCADE'],
      },
      {
        table: 'note_versions',
        name: 'note_versions_workspace_id_fkey',
        type: 'f',
        includes: ['FOREIGN KEY', 'workspace_id', 'workspaces', 'ON DELETE CASCADE'],
      },
      {
        table: 'agent_tokens',
        name: 'agent_tokens_pkey',
        type: 'p',
        includes: ['PRIMARY KEY', 'id'],
      },
      {
        table: 'agent_tokens',
        name: 'agent_tokens_workspace_id_fkey',
        type: 'f',
        includes: ['FOREIGN KEY', 'workspace_id', 'workspaces', 'ON DELETE CASCADE'],
      },
      {
        table: 'activity_log',
        name: 'activity_log_pkey',
        type: 'p',
        includes: ['PRIMARY KEY', 'id'],
      },
      {
        table: 'activity_log',
        name: 'activity_log_workspace_id_fkey',
        type: 'f',
        includes: ['FOREIGN KEY', 'workspace_id', 'workspaces', 'ON DELETE CASCADE'],
      },
      { table: 'devices', name: 'devices_pkey', type: 'p', includes: ['PRIMARY KEY', 'id'] },
      {
        table: 'devices',
        name: 'devices_workspace_id_fkey',
        type: 'f',
        includes: ['FOREIGN KEY', 'workspace_id', 'workspaces', 'ON DELETE CASCADE'],
      },
      {
        table: 'subscriptions',
        name: 'subscriptions_pkey',
        type: 'p',
        includes: ['PRIMARY KEY', 'workspace_id'],
      },
      {
        table: 'subscriptions',
        name: 'subscriptions_workspace_id_fkey',
        type: 'f',
        includes: ['FOREIGN KEY', 'workspace_id', 'workspaces', 'ON DELETE CASCADE'],
      },
    ],
    policies: [
      workspaceIsolationPolicy('workspace_members'),
      workspaceIsolationPolicy('notes'),
      workspaceIsolationPolicy('note_versions'),
      workspaceIsolationPolicy('activity_log'),
      workspaceIsolationPolicy('devices'),
      workspaceIsolationPolicy('subscriptions'),
    ],
    rls: [
      { table: 'users', enabled: false, forced: false },
      { table: 'agent_tokens', enabled: false, forced: false },
    ],
  },
  {
    name: '0002_search_and_tags.sql',
    checksum: '1f7d745b90a81c39489c1550f1f3be0762b88d6a8f62b10c470383c7405c6f0e',
    columnDefinitions: [
      {
        table: 'notes',
        column: 'tags',
        dataType: 'jsonb',
        nullable: false,
        defaultExpression: `'[]'::jsonb`,
      },
      {
        table: 'note_versions',
        column: 'tags',
        dataType: 'jsonb',
        nullable: false,
        defaultExpression: `'[]'::jsonb`,
      },
      {
        table: 'notes',
        column: 'search_vector',
        dataType: 'tsvector',
        nullable: true,
        generated: true,
        generationIncludes: ['to_tsvector', 'english', 'title', 'body_md'],
      },
    ],
    indexDefinitions: [
      { name: 'notes_search_idx', includes: ['USING gin', 'search_vector'] },
      { name: 'notes_tags_idx', includes: ['USING gin', 'tags'] },
    ],
  },
];

/**
 * Exact 0003 postconditions. They are authoritative while 0003 is the applied head;
 * a later migration may intentionally supersede one after this state has been proven.
 */
const SYNC_V2_SIGNATURE: LegacySignature = {
  name: '0003_sync_v2.sql',
  tableDefinitions: [
    {
      table: 'workspace_sync_cursors',
      columns: ['workspace_id', 'last_seq'],
    },
    {
      table: 'sync_idempotency',
      columns: [
        'workspace_id',
        'op_id',
        'actor_type',
        'actor_id',
        'device_id',
        'receipt_version',
        'request_fingerprint',
        'outcome',
        'created_at',
      ],
    },
  ],
  columnDefinitions: [
    ...defineColumns('notes', [['sync_seq', 'bigint', false, '0']]),
    ...defineColumns('workspace_sync_cursors', [
      ['workspace_id', 'uuid', false],
      ['last_seq', 'bigint', false, '0'],
    ]),
    ...defineColumns('sync_idempotency', [
      ['workspace_id', 'uuid', false],
      ['op_id', 'text', false],
      ['actor_type', 'text', false],
      ['actor_id', 'uuid', false],
      ['device_id', 'text', false],
      ['receipt_version', 'smallint', false, '1'],
      ['request_fingerprint', 'text', false],
      ['outcome', 'jsonb', true],
      ['created_at', 'timestamp with time zone', false, 'now()'],
    ]),
  ],
  constraints: [
    {
      table: 'notes',
      name: 'notes_pkey',
      type: 'p',
      includes: ['PRIMARY KEY (workspace_id, id)'],
      predecessorIncludes: ['PRIMARY KEY (id)'],
      definition: 'PRIMARY KEY (workspace_id, id)',
      predecessorDefinition: 'PRIMARY KEY (id)',
    },
    {
      table: 'devices',
      name: 'devices_pkey',
      type: 'p',
      includes: ['PRIMARY KEY (workspace_id, id)'],
      predecessorIncludes: ['PRIMARY KEY (id)'],
      definition: 'PRIMARY KEY (workspace_id, id)',
      predecessorDefinition: 'PRIMARY KEY (id)',
    },
    {
      table: 'note_versions',
      name: 'note_versions_note_id_fkey',
      type: 'f',
      includes: [
        'FOREIGN KEY (workspace_id, note_id)',
        'REFERENCES notes(workspace_id, id)',
        'ON DELETE CASCADE',
      ],
      predecessorIncludes: ['FOREIGN KEY (note_id)', 'REFERENCES notes(id)'],
      definition:
        'FOREIGN KEY (workspace_id, note_id) REFERENCES notes(workspace_id, id) ON DELETE CASCADE',
      predecessorDefinition: 'FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE',
    },
    {
      table: 'workspace_sync_cursors',
      name: 'workspace_sync_cursors_pkey',
      type: 'p',
      includes: ['PRIMARY KEY (workspace_id)'],
      definition: 'PRIMARY KEY (workspace_id)',
    },
    {
      table: 'workspace_sync_cursors',
      name: 'workspace_sync_cursors_workspace_id_fkey',
      type: 'f',
      includes: ['FOREIGN KEY (workspace_id)', 'REFERENCES workspaces(id)', 'ON DELETE CASCADE'],
      definition: 'FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE',
    },
    {
      table: 'workspace_sync_cursors',
      name: 'workspace_sync_cursors_last_seq_check',
      type: 'c',
      includes: ['CHECK', 'last_seq >= 0'],
      definition: 'CHECK ((last_seq >= 0))',
    },
    {
      table: 'sync_idempotency',
      name: 'sync_idempotency_pkey',
      type: 'p',
      includes: ['PRIMARY KEY (workspace_id, op_id)'],
      definition: 'PRIMARY KEY (workspace_id, op_id)',
    },
    {
      table: 'sync_idempotency',
      name: 'sync_idempotency_workspace_id_fkey',
      type: 'f',
      includes: ['FOREIGN KEY (workspace_id)', 'REFERENCES workspaces(id)', 'ON DELETE CASCADE'],
      definition: 'FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE',
    },
    {
      table: 'sync_idempotency',
      name: 'sync_idempotency_receipt_version_check',
      type: 'c',
      includes: ['CHECK', 'receipt_version >= 1'],
      definition: 'CHECK ((receipt_version >= 1))',
    },
  ],
  indexDefinitions: [
    {
      name: 'notes_sync_idx',
      includes: ['UNIQUE INDEX', 'workspace_id', 'sync_seq'],
      table: 'notes',
      unique: true,
      definitionSuffix: 'USING btree (workspace_id, sync_seq)',
      predecessorIncludes: ['INDEX', 'USING btree (workspace_id, updated_at, id)'],
      predecessorUnique: false,
      predecessorDefinitionSuffix: 'USING btree (workspace_id, updated_at, id)',
    },
    {
      name: 'note_versions_unique',
      includes: ['UNIQUE INDEX', 'workspace_id', 'note_id', 'version'],
      table: 'note_versions',
      unique: true,
      definitionSuffix: 'USING btree (workspace_id, note_id, version)',
      predecessorIncludes: ['UNIQUE INDEX', 'USING btree (note_id, version)'],
      predecessorUnique: true,
      predecessorDefinitionSuffix: 'USING btree (note_id, version)',
    },
  ],
  policies: [
    workspaceIsolationPolicy('notes', true),
    workspaceIsolationPolicy('note_versions', true),
    workspaceIsolationPolicy('devices', true),
    workspaceIsolationPolicy('workspace_sync_cursors'),
    workspaceIsolationPolicy('sync_idempotency'),
  ],
  triggers: [
    {
      table: 'notes',
      name: 'notes_sync_cursor_lock',
      enabled: 'O',
      timing: 'BEFORE',
      events: ['INSERT', 'UPDATE'],
      orientation: 'STATEMENT',
      functionName: 'iris_lock_workspace_sync_cursor',
    },
    {
      table: 'notes',
      name: 'notes_sync_seq_assign',
      enabled: 'O',
      timing: 'BEFORE',
      events: ['INSERT', 'UPDATE'],
      orientation: 'ROW',
      functionName: 'iris_assign_note_sync_seq',
    },
  ],
  functions: [
    {
      name: 'iris_lock_workspace_sync_cursor',
      language: 'plpgsql',
      returnType: 'trigger',
      volatility: 'v',
      securityDefiner: false,
      body: `DECLARE
  current_workspace text := current_setting('app.current_workspace', true);
BEGIN
  IF current_workspace IS NULL OR current_workspace = '' THEN
    RAISE EXCEPTION 'note mutation requires app.current_workspace';
  END IF;

  INSERT INTO workspace_sync_cursors AS cursors (workspace_id, last_seq)
  VALUES (current_workspace::uuid, 0)
  ON CONFLICT (workspace_id) DO UPDATE
  SET last_seq = cursors.last_seq;

  RETURN NULL;
END`,
    },
    {
      name: 'iris_assign_note_sync_seq',
      language: 'plpgsql',
      returnType: 'trigger',
      volatility: 'v',
      securityDefiner: false,
      body: `DECLARE
  current_workspace uuid :=
    NULLIF(current_setting('app.current_workspace', true), '')::uuid;
BEGIN
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
END`,
    },
  ],
};

/**
 * Exact 0004 delta. Existing notes/note_versions policies are preexisting evidence:
 * they must still be exact after the RLS-suspended backfill, but cannot make an
 * unledgered 0004 appear present before either new column exists.
 */
const NOTE_VERSION_ORGANIZATION_SIGNATURE: LegacySignature = {
  name: '0004_note_version_organization.sql',
  columnDefinitions: [
    {
      table: 'note_versions',
      column: 'folder',
      dataType: 'text',
      nullable: true,
    },
    {
      table: 'note_versions',
      column: 'folder_snapshot_known',
      dataType: 'boolean',
      nullable: false,
      defaultExpression: 'false',
    },
  ],
  policies: [
    workspaceIsolationPolicy('notes', true),
    workspaceIsolationPolicy('note_versions', true),
  ],
};

// Additive successors retain earlier load-bearing artifacts. Every receipt in this
// list is therefore re-proven on startup; a future superseding migration must replace
// its signature deliberately rather than disabling verification by accident.
const MIGRATION_ARTIFACT_SIGNATURES = [SYNC_V2_SIGNATURE, NOTE_VERSION_ORGANIZATION_SIGNATURE];

const pgliteMigrationQueues = new WeakMap<PGlite, Promise<void>>();

export function migrationSql(): { name: string; sql: string }[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(`${migrationsDir}/${name}`, 'utf8') }));
}

function checksum(sql: string): string {
  // Git may materialize text files with CRLF on Windows. Migration identity is the
  // canonical SQL content, not the checkout's line-ending convention.
  return createHash('sha256').update(sql.replace(/\r\n?/g, '\n')).digest('hex');
}

async function exists(client: QueryClient, sql: string, values: unknown[]): Promise<boolean> {
  const result = await client.query<{ found: boolean }>(sql, values);
  return result.rows[0]?.found === true;
}

const artifactState = (present: boolean, matches = present, evidence = present): ArtifactState => ({
  present,
  matches,
  evidence,
});

const tableExists = (client: QueryClient, table: string) =>
  exists(
    client,
    `SELECT to_regclass(quote_ident(current_schema()) || '.' || quote_ident($1))
       IS NOT NULL AS found`,
    [table],
  );

async function tableDefinitionState(
  client: QueryClient,
  definition: NonNullable<LegacySignature['tableDefinitions']>[number],
): Promise<ArtifactState> {
  const result = await client.query<{ column_name: string }>(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1
     ORDER BY column_name`,
    [definition.table],
  );
  const present = result.rows.length > 0;
  const recorded = result.rows.map((row) => row.column_name).sort();
  const expected = [...definition.columns].sort();
  return artifactState(
    present,
    recorded.length === expected.length &&
      recorded.every((column, index) => column === expected[index]),
    present && !definition.preexisting,
  );
}

const columnExists = (client: QueryClient, table: string, column: string) =>
  exists(
    client,
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2
     ) AS found`,
    [table, column],
  );

async function columnDefinitionState(
  client: QueryClient,
  definition: LegacyColumnDefinition,
): Promise<ArtifactState> {
  const result = await client.query<{
    data_type: string;
    is_nullable: 'YES' | 'NO';
    column_default: string | null;
    is_generated: 'ALWAYS' | 'NEVER';
    generation_expression: string | null;
  }>(
    `SELECT data_type, is_nullable, column_default, is_generated, generation_expression
     FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
    [definition.table, definition.column],
  );
  const column = result.rows[0];
  if (!column) return artifactState(false);
  const generation = column.generation_expression ?? '';
  return artifactState(
    true,
    column.data_type === definition.dataType &&
      (column.is_nullable === 'YES') === definition.nullable &&
      (column.is_generated === 'ALWAYS') === (definition.generated ?? false) &&
      normalizeCatalogExpression(column.column_default) ===
        normalizeCatalogExpression(definition.defaultExpression ?? null) &&
      (definition.generationIncludes ?? []).every((part) => generation.includes(part)),
  );
}

const indexExists = (client: QueryClient, index: string) =>
  exists(
    client,
    `SELECT to_regclass(quote_ident(current_schema()) || '.' || quote_ident($1))
       IS NOT NULL AS found`,
    [index],
  );

function normalizeCatalogExpression(expression: string | null): string {
  return (expression ?? '').replace(/\s+/g, ' ').trim();
}

async function policyDefinitionsState(
  client: QueryClient,
  definitions: LegacyPolicyDefinition[],
): Promise<ArtifactState> {
  if (definitions.length === 0) return artifactState(false);
  const table = definitions[0]!.table;
  const result = await client.query<{
    name: string;
    permissive: string;
    roles: string[];
    command: string;
    using_expression: string | null;
    check_expression: string | null;
    rls_enabled: boolean;
    rls_forced: boolean;
  }>(
    `SELECT policy.policyname AS name,
            policy.permissive,
            policy.roles::text[] AS roles,
            policy.cmd AS command,
            policy.qual AS using_expression,
            policy.with_check AS check_expression,
            relation.relrowsecurity AS rls_enabled,
            relation.relforcerowsecurity AS rls_forced
     FROM pg_policies AS policy
     JOIN pg_namespace AS namespace ON namespace.nspname = policy.schemaname
     JOIN pg_class AS relation
       ON relation.relnamespace = namespace.oid AND relation.relname = policy.tablename
     WHERE policy.schemaname = current_schema()
       AND policy.tablename = $1`,
    [table],
  );
  return artifactState(
    result.rows.length > 0,
    result.rows.length === definitions.length &&
      result.rows.every((policy) => {
        const definition = definitions.find((candidate) => candidate.name === policy.name);
        if (!definition || definition.table !== table || !Array.isArray(policy.roles)) return false;
        return (
          policy.rls_enabled &&
          policy.rls_forced &&
          policy.permissive === definition.permissive &&
          policy.command === definition.command &&
          [...policy.roles].sort().join('\0') === [...definition.roles].sort().join('\0') &&
          normalizeCatalogExpression(policy.using_expression) ===
            normalizeCatalogExpression(definition.usingExpression) &&
          normalizeCatalogExpression(policy.check_expression) ===
            normalizeCatalogExpression(definition.checkExpression)
        );
      }),
    result.rows.length > 0 && !definitions.every((definition) => definition.preexisting),
  );
}

async function rlsDefinitionState(
  client: QueryClient,
  definition: LegacyRlsDefinition,
): Promise<ArtifactState> {
  const result = await client.query<{ enabled: boolean; forced: boolean }>(
    `SELECT relation.relrowsecurity AS enabled, relation.relforcerowsecurity AS forced
     FROM pg_class AS relation
     JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = current_schema() AND relation.relname = $1`,
    [definition.table],
  );
  const rls = result.rows[0];
  return artifactState(
    rls !== undefined,
    rls?.enabled === definition.enabled && rls.forced === definition.forced,
  );
}

async function triggerDefinitionState(
  client: QueryClient,
  expected: NonNullable<LegacySignature['triggers']>[number],
): Promise<ArtifactState> {
  const result = await client.query<{
    enabled: string;
    type: number;
    function_name: string;
    function_in_schema: boolean;
  }>(
    `SELECT trigger.tgenabled AS enabled,
            trigger.tgtype::integer AS type,
            function.proname AS function_name,
            function_namespace.nspname = current_schema() AS function_in_schema
     FROM pg_trigger AS trigger
     JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
     JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     JOIN pg_proc AS function ON function.oid = trigger.tgfoid
     JOIN pg_namespace AS function_namespace ON function_namespace.oid = function.pronamespace
     WHERE namespace.nspname = current_schema()
       AND relation.relname = $1
       AND trigger.tgname = $2
       AND NOT trigger.tgisinternal`,
    [expected.table, expected.name],
  );
  const trigger = result.rows[0];
  if (!trigger) return artifactState(false);
  const events: Array<'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE'> = [];
  if ((trigger.type & 4) !== 0) events.push('INSERT');
  if ((trigger.type & 16) !== 0) events.push('UPDATE');
  if ((trigger.type & 8) !== 0) events.push('DELETE');
  if ((trigger.type & 32) !== 0) events.push('TRUNCATE');
  const timing =
    (trigger.type & 64) !== 0 ? 'INSTEAD OF' : (trigger.type & 2) !== 0 ? 'BEFORE' : 'AFTER';
  const orientation = (trigger.type & 1) !== 0 ? 'ROW' : 'STATEMENT';
  return artifactState(
    true,
    trigger.enabled === expected.enabled &&
      timing === expected.timing &&
      orientation === expected.orientation &&
      events.sort().join('\0') === [...expected.events].sort().join('\0') &&
      trigger.function_in_schema &&
      trigger.function_name === expected.functionName,
  );
}

function normalizeFunctionSource(source: string): string {
  return source.replace(/\s+/g, ' ').trim().toLowerCase();
}

async function functionDefinitionState(
  client: QueryClient,
  expected: NonNullable<LegacySignature['functions']>[number],
): Promise<ArtifactState> {
  const result = await client.query<{
    language: string;
    return_type: string;
    volatility: 'i' | 's' | 'v';
    security_definer: boolean;
    source: string;
  }>(
    `SELECT language.lanname AS language,
            pg_get_function_result(function.oid) AS return_type,
            function.provolatile AS volatility,
            function.prosecdef AS security_definer,
            function.prosrc AS source
     FROM pg_proc AS function
     JOIN pg_namespace AS namespace ON namespace.oid = function.pronamespace
     JOIN pg_language AS language ON language.oid = function.prolang
     WHERE namespace.nspname = current_schema()
       AND function.proname = $1
       AND function.pronargs = 0`,
    [expected.name],
  );
  const recorded = result.rows[0];
  if (!recorded) return artifactState(false);
  const source = normalizeFunctionSource(recorded.source);
  return artifactState(
    true,
    result.rows.length === 1 &&
      recorded.language === expected.language &&
      recorded.return_type === expected.returnType &&
      recorded.volatility === expected.volatility &&
      recorded.security_definer === expected.securityDefiner &&
      source === normalizeFunctionSource(expected.body),
  );
}

async function indexDefinitionState(
  client: QueryClient,
  expected: NonNullable<LegacySignature['indexDefinitions']>[number],
): Promise<ArtifactState> {
  const result = await client.query<{
    definition: string;
    table_name: string;
    is_unique: boolean;
  }>(
    `SELECT pg_get_indexdef(index_relation.oid) AS definition,
            table_relation.relname AS table_name,
            index_state.indisunique AS is_unique
     FROM pg_class AS index_relation
     JOIN pg_namespace AS namespace ON namespace.oid = index_relation.relnamespace
     JOIN pg_index AS index_state ON index_state.indexrelid = index_relation.oid
     JOIN pg_class AS table_relation ON table_relation.oid = index_state.indrelid
     WHERE namespace.nspname = current_schema()
       AND index_relation.relname = $1`,
    [expected.name],
  );
  const recorded = result.rows[0];
  if (!recorded) return artifactState(false);
  const definition = normalizeCatalogExpression(recorded.definition);
  const tableMatches = expected.table === undefined || recorded.table_name === expected.table;
  const uniqueMatches = expected.unique === undefined || recorded.is_unique === expected.unique;
  const definitionMatches =
    expected.definitionSuffix === undefined ||
    definition.endsWith(normalizeCatalogExpression(expected.definitionSuffix));
  const matches =
    tableMatches &&
    uniqueMatches &&
    expected.includes.every((fragment) => definition.includes(fragment)) &&
    definitionMatches;
  const hasPredecessor =
    expected.predecessorIncludes !== undefined ||
    expected.predecessorUnique !== undefined ||
    expected.predecessorDefinitionSuffix !== undefined;
  const predecessorUniqueMatches =
    expected.predecessorUnique === undefined || recorded.is_unique === expected.predecessorUnique;
  const predecessorDefinitionMatches =
    expected.predecessorDefinitionSuffix === undefined ||
    definition.endsWith(normalizeCatalogExpression(expected.predecessorDefinitionSuffix));
  const matchesPredecessor =
    hasPredecessor &&
    tableMatches &&
    predecessorUniqueMatches &&
    (expected.predecessorIncludes ?? []).every((fragment) => definition.includes(fragment)) &&
    predecessorDefinitionMatches;
  return artifactState(!matchesPredecessor, matches);
}

async function constraintDefinitionState(
  client: QueryClient,
  constraint: NonNullable<LegacySignature['constraints']>[number],
): Promise<ArtifactState> {
  const result = await client.query<{ type: string; definition: string }>(
    `SELECT c.contype AS type, pg_get_constraintdef(c.oid) AS definition
     FROM pg_constraint AS c
     JOIN pg_class AS relation ON relation.oid = c.conrelid
     JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = current_schema()
       AND relation.relname = $1
       AND c.conname = $2`,
    [constraint.table, constraint.name],
  );
  const recorded = result.rows[0];
  if (!recorded) return artifactState(false);
  const definition = normalizeCatalogExpression(recorded.definition);
  const definitionMatches =
    constraint.definition === undefined ||
    definition === normalizeCatalogExpression(constraint.definition);
  const hasPredecessor =
    constraint.predecessorIncludes !== undefined || constraint.predecessorDefinition !== undefined;
  const predecessorDefinitionMatches =
    constraint.predecessorDefinition === undefined ||
    definition === normalizeCatalogExpression(constraint.predecessorDefinition);
  const matchesPredecessor =
    hasPredecessor &&
    recorded.type === constraint.type &&
    (constraint.predecessorIncludes ?? []).every((fragment) => definition.includes(fragment)) &&
    predecessorDefinitionMatches;
  return artifactState(
    !matchesPredecessor,
    recorded.type === constraint.type &&
      constraint.includes.every((fragment) => definition.includes(fragment)) &&
      definitionMatches,
  );
}

async function signatureState(
  client: QueryClient,
  signature: LegacySignature,
): Promise<{ any: boolean; complete: boolean; evidence: string[]; failures: string[] }> {
  const checks: Array<{ artifact: string; state: ArtifactState }> = [];
  const record = (artifact: string, state: ArtifactState): void => {
    checks.push({ artifact, state });
  };
  for (const table of signature.tables ?? []) {
    record(`table ${table}`, artifactState(await tableExists(client, table)));
  }
  for (const definition of signature.tableDefinitions ?? []) {
    record(`table definition ${definition.table}`, await tableDefinitionState(client, definition));
  }
  for (const [table, column] of signature.columns ?? []) {
    record(`column ${table}.${column}`, artifactState(await columnExists(client, table, column)));
  }
  for (const definition of signature.columnDefinitions ?? []) {
    record(
      `column definition ${definition.table}.${definition.column}`,
      await columnDefinitionState(client, definition),
    );
  }
  for (const index of signature.indexes ?? []) {
    record(`index ${index}`, artifactState(await indexExists(client, index)));
  }
  const policiesByTable = new Map<string, LegacyPolicyDefinition[]>();
  for (const definition of signature.policies ?? []) {
    const definitions = policiesByTable.get(definition.table) ?? [];
    definitions.push(definition);
    policiesByTable.set(definition.table, definitions);
  }
  for (const [table, definitions] of policiesByTable) {
    record(
      `RLS policy ${table}.workspace_isolation`,
      await policyDefinitionsState(client, definitions),
    );
  }
  for (const definition of signature.rls ?? []) {
    record(`RLS state ${definition.table}`, await rlsDefinitionState(client, definition));
  }
  for (const definition of signature.triggers ?? []) {
    record(
      `trigger ${definition.table}.${definition.name}`,
      await triggerDefinitionState(client, definition),
    );
  }
  for (const definition of signature.functions ?? []) {
    record(`function ${definition.name}`, await functionDefinitionState(client, definition));
  }
  for (const definition of signature.indexDefinitions ?? []) {
    record(`index definition ${definition.name}`, await indexDefinitionState(client, definition));
  }
  for (const constraint of signature.constraints ?? []) {
    record(
      `constraint ${constraint.table}.${constraint.name}`,
      await constraintDefinitionState(client, constraint),
    );
  }
  const failures = checks
    .filter(({ state }) => !state.present || !state.matches)
    .map(({ artifact, state }) => `${artifact} ${state.present ? 'drifted' : 'missing'}`);
  const evidence = checks.filter(({ state }) => state.evidence).map(({ artifact }) => artifact);
  return {
    any: evidence.length > 0,
    complete: checks.length > 0 && failures.length === 0,
    evidence,
    failures,
  };
}

async function assertMigrationArtifactConsistency(
  client: QueryClient,
  signature: LegacySignature,
  expectedState: 'absent' | 'current',
): Promise<void> {
  const state = await signatureState(client, signature);
  if (expectedState === 'absent' && state.any) {
    throw new Error(
      `Database contains unledgered ${signature.name} artifacts; refusing to guess: ${state.evidence.join(', ')}`,
    );
  }
  if (expectedState === 'current' && !state.complete) {
    throw new Error(
      `Database migration ${signature.name} receipt does not match its schema artifacts: ${state.failures.join(', ')}`,
    );
  }
}

async function baselineLegacyDatabase(
  client: QueryClient,
  migrations: { name: string; sql: string }[],
): Promise<void> {
  const count = await client.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM iris_schema_migrations',
  );
  if (count.rows[0]?.count !== '0') return;

  const available = new Map(migrations.map((migration) => [migration.name, migration]));
  const applied: string[] = [];
  let missingEarlier = false;

  for (const signature of LEGACY_SIGNATURES) {
    const state = await signatureState(client, signature);
    if (state.any && !state.complete) {
      throw new Error(
        `Legacy database has a partial or unrecognized ${signature.name} schema; refusing to guess`,
      );
    }
    if (!state.complete) {
      missingEarlier = true;
      continue;
    }
    if (missingEarlier) {
      throw new Error(`Legacy database contains ${signature.name} without its predecessor`);
    }
    if (!available.has(signature.name)) {
      throw new Error(`Legacy database requires missing migration file ${signature.name}`);
    }
    const migration = available.get(signature.name)!;
    if (!signature.checksum || checksum(migration.sql) !== signature.checksum) {
      throw new Error(`Legacy baseline checksum mismatch for ${signature.name}`);
    }
    applied.push(signature.name);
  }

  for (const signature of MIGRATION_ARTIFACT_SIGNATURES) {
    await assertMigrationArtifactConsistency(client, signature, 'absent');
  }

  if (applied.length === 0) return;
  const values: unknown[] = [];
  const rows = applied.map((name, index) => {
    const signature = LEGACY_SIGNATURES.find((item) => item.name === name)!;
    values.push(name, signature.checksum);
    const offset = index * 2;
    return `($${offset + 1}, $${offset + 2})`;
  });
  await client.query(
    `INSERT INTO iris_schema_migrations (name, checksum) VALUES ${rows.join(', ')}`,
    values,
  );
}

async function prepareMigrationState(
  client: QueryClient,
  migrations: { name: string; sql: string }[],
): Promise<Set<string>> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS iris_schema_migrations (
      name       text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await baselineLegacyDatabase(client, migrations);

  const rows = await client.query<{ name: string; checksum: string }>(
    'SELECT name, checksum FROM iris_schema_migrations ORDER BY name',
  );
  const known = new Map(migrations.map((migration) => [migration.name, migration]));
  const applied = new Map(rows.rows.map((row) => [row.name, row.checksum]));

  for (const name of applied.keys()) {
    if (!known.has(name)) {
      throw new Error(`Database migration ${name} is not present in this build`);
    }
  }

  let sawGap = false;
  for (const migration of migrations) {
    const recorded = applied.get(migration.name);
    if (!recorded) {
      sawGap = true;
      continue;
    }
    if (sawGap)
      throw new Error(`Database migration history is not contiguous at ${migration.name}`);
    if (recorded !== checksum(migration.sql)) {
      throw new Error(`Database migration checksum mismatch for ${migration.name}`);
    }
  }

  for (const signature of MIGRATION_ARTIFACT_SIGNATURES) {
    await assertMigrationArtifactConsistency(
      client,
      signature,
      applied.has(signature.name) ? 'current' : 'absent',
    );
  }

  return new Set(applied.keys());
}

async function recordMigration(client: QueryClient, name: string, sql: string): Promise<void> {
  await client.query('INSERT INTO iris_schema_migrations (name, checksum) VALUES ($1, $2)', [
    name,
    checksum(sql),
  ]);
}

/** Apply all migrations to a PGlite instance (dev/test path). */
async function applyMigrationsPgliteUnlocked(client: PGlite): Promise<void> {
  const migrations = migrationSql();
  const applied = await prepareMigrationState(client, migrations);
  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    await client.transaction(async (tx) => {
      await tx.exec(migration.sql);
      await recordMigration(tx, migration.name, migration.sql);
      for (const signature of MIGRATION_ARTIFACT_SIGNATURES) {
        if (signature.name > migration.name) continue;
        await assertMigrationArtifactConsistency(tx, signature, 'current');
      }
    });
  }
}

export function applyMigrationsPglite(client: PGlite): Promise<void> {
  const previous = pgliteMigrationQueues.get(client) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => applyMigrationsPgliteUnlocked(client));
  pgliteMigrationQueues.set(client, run);
  return run.finally(() => {
    if (pgliteMigrationQueues.get(client) === run) pgliteMigrationQueues.delete(client);
  });
}

/** Apply all migrations to a real cluster via node-postgres (production path). */
export async function applyMigrationsPostgres(connectionString: string): Promise<void> {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString });
  let client: PoolClient | null = null;
  let lockAcquired = false;
  let operationFailed = false;
  let operationError: unknown;
  try {
    client = await pool.connect();
    await client.query('SELECT pg_advisory_lock($1, $2)', [MIGRATION_LOCK_A, MIGRATION_LOCK_B]);
    lockAcquired = true;
    const migrations = migrationSql();
    const applied = await prepareMigrationState(client, migrations);
    for (const migration of migrations) {
      if (applied.has(migration.name)) continue;
      console.log(`applying ${migration.name}`);
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await recordMigration(client, migration.name, migration.sql);
        for (const signature of MIGRATION_ARTIFACT_SIGNATURES) {
          if (signature.name > migration.name) continue;
          await assertMigrationArtifactConsistency(client, signature, 'current');
        }
        await client.query('COMMIT');
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Releasing the connection below clears any failed transaction. Preserve the
          // migration/commit failure that explains why this receipt was not recorded.
        }
        throw error;
      }
    }
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  let cleanupError: unknown;
  if (client && lockAcquired) {
    try {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [MIGRATION_LOCK_A, MIGRATION_LOCK_B]);
    } catch (error) {
      cleanupError = error;
    }
  }
  try {
    client?.release();
  } catch (error) {
    cleanupError ??= error;
  }
  try {
    await pool.end();
  } catch (error) {
    cleanupError ??= error;
  }
  // Releasing/closing the connection also releases a session advisory lock. Surface
  // cleanup failure only when it cannot mask the migration or connection failure.
  if (operationFailed) throw operationError;
  if (cleanupError) throw cleanupError;
}

async function main(): Promise<void> {
  if (env.databaseUrl) {
    await applyMigrationsPostgres(env.databaseUrl);
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(env.pglitePath, { recursive: true });
    const client = new PGlite(env.pglitePath);
    await applyMigrationsPglite(client);
    await client.close();
  }
  console.log('migrations applied');
}

// Run as a CLI when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
