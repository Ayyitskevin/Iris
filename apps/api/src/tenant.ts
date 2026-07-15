import type { Database } from './db/client';
import { withWorkspace } from './db/client';
import type { Principal } from './auth/provider';
import type { Ctx } from './context';

/**
 * Run a unit of work inside the authenticated principal's tenant: opens one
 * transaction, sets the RLS GUC (ADR-003), and hands services a `Ctx` whose `db` is
 * that transaction. Every read and write in a request therefore shares one atomic,
 * workspace-scoped transaction.
 */
export function runTenant<T>(
  db: Database,
  principal: Principal,
  fn: (ctx: Ctx) => Promise<T>,
): Promise<T> {
  return withWorkspace(db, principal.workspaceId, (tx) =>
    fn({ db: tx, principal, workspaceId: principal.workspaceId }),
  );
}
