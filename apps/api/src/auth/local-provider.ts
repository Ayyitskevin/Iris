/**
 * LocalAuthProvider — email + password (scrypt) + JWT sessions. Self-contained so the
 * whole foundation runs offline with no external accounts (ADR-004). Sign-up is also
 * the tenant-provisioning path: every new user gets their own workspace.
 */
import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { subscriptions, users, workspaceMembers, workspaces } from '../db/schema';
import { hashSecret, verifySecret } from '../lib/hash';
import { newId } from '../lib/ids';
import { badRequest, unauthorized } from '../lib/errors';
import type { AuthedUser, AuthProvider } from './provider';

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export const localAuthProvider: AuthProvider = {
  name: 'local',

  async signUp(db, input): Promise<AuthedUser> {
    const email = normalizeEmail(input.email);
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (existing.length > 0) {
      throw badRequest('An account with that email already exists', 'email_taken');
    }

    const userId = newId();
    const workspaceId = newId();
    const passwordHash = await hashSecret(input.password);

    await db.transaction(async (tx) => {
      // users + workspaces are not workspace-scoped, so no GUC needed for them.
      await tx.insert(users).values({
        id: userId,
        email,
        displayName: input.displayName,
        passwordHash,
      });
      await tx.insert(workspaces).values({
        id: workspaceId,
        // A personal workspace, named after the person for now.
        name: `${input.displayName}'s workspace`,
      });
      // Tenant-scoped inserts below are gated by RLS in production; set the GUC.
      await tx.execute(sql`select set_config('app.current_workspace', ${workspaceId}, true)`);
      await tx.insert(workspaceMembers).values({
        id: newId(),
        workspaceId,
        userId,
        role: 'owner',
      });
      await tx.insert(subscriptions).values({
        workspaceId,
        plan: 'free',
        status: 'none',
      });
    });

    return { userId, workspaceId, email, displayName: input.displayName };
  },

  async signIn(db, input): Promise<AuthedUser> {
    const email = normalizeEmail(input.email);
    const rows = await db.select().from(users).where(eq(users.email, email));
    const user = rows[0];
    if (!user || !user.passwordHash) {
      throw unauthorized('Invalid email or password');
    }
    const ok = await verifySecret(input.password, user.passwordHash);
    if (!ok) {
      throw unauthorized('Invalid email or password');
    }

    // Foundation: one workspace per user (the membership seam allows more later).
    const memberships = await db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, user.id)))
      .orderBy(workspaceMembers.createdAt);
    const workspaceId = memberships[0]?.workspaceId;
    if (!workspaceId) {
      throw unauthorized('Account has no workspace');
    }

    return { userId: user.id, workspaceId, email: user.email, displayName: user.displayName };
  },
};
