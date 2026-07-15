---
name: auth-provider-seam
description: Open when swapping Iris's local email+password auth for a managed provider (Clerk/Supabase), adding OAuth/password-reset/email-verification, or changing how sign-up provisions a tenant.
---

## When to use

- You need to make `AUTH_PROVIDER=clerk` or `=supabase` actually work — right now `getAuthProvider()` throws "documented seam but not implemented" for both (`apps/api/src/auth/index.ts:13-18`).
- You're adding OAuth, password reset, or email verification. These are **deliberately absent** from the local provider (ADR-004) and are the managed provider's job.
- You're changing what sign-up creates, or debugging: `email_taken`, "Account has no workspace" (`local-provider.ts:83`), an RLS/`workspace_id` failure during sign-up, or a session that resolves to the wrong tenant.
- You're touching how a **user** request resolves to a `Principal`. (Agent tokens `iris_at_…` are a *separate* path — see gotchas — don't edit them here.)

## Mental model

The seam is exactly **two methods**: `signUp` and `signIn` on the `AuthProvider` interface (`apps/api/src/auth/provider.ts:29-38`). `getAuthProvider()` picks one impl by `env.authProvider`. Only `localAuthProvider` exists today.

Two ideas that are easy to conflate but are separate:
1. **Establishing identity at the door** — `signUp`/`signIn` verify who someone is and (for sign-up) provision their tenant. The provider only runs *here*, at the two auth routes.
2. **Authorizing every subsequent request** — done by `resolvePrincipal` → `verifySession`, which validates an **Iris-owned JWT** (`jose`, HS256, 30d, claims `sub`=userId + `wid`=workspaceId; `apps/api/src/auth/jwt.ts`). The provider is **not** in this hot path.

So the routes call the provider once, get back an `AuthedUser`, then **Iris mints its own JWT** (`app.ts:120,127` → `signSession`). Swapping providers changes step 1, not step 2 — unless you deliberately move session ownership to the provider (a bigger change; see gotchas). `signUp` is also the **only tenant-provisioning path**: user + workspace + membership + free subscription are all born here.

## Key files

- `apps/api/src/auth/provider.ts` — the `AuthProvider` interface (`signUp`, `signIn`, `name`) plus the `Principal` and `AuthedUser` types. This is the contract a new provider implements.
- `apps/api/src/auth/local-provider.ts` — `localAuthProvider`: the reference impl. `signUp` (`:21`) is the tenant-provisioning template; `signIn` (`:63`) verifies scrypt hash and resolves the workspace via membership.
- `apps/api/src/auth/index.ts` — `getAuthProvider()`: the `switch (env.authProvider)` selector. Register your new provider here.
- `apps/api/src/auth/jwt.ts` — `signSession`/`verifySession` and `SessionClaims {sub, wid}`. Iris owns sessions regardless of provider (unless you change this).
- `apps/api/src/env.ts:28` — `authProvider` from `AUTH_PROVIDER` (default `'local'`).
- `apps/api/src/app.ts:117-129` — the `/v1/auth/sign-up` and `/v1/auth/sign-in` routes: parse zod input, call the provider **with `app.db` (not a tenant `Ctx`)**, then `signSession`, then `buildAuthResponse`.
- `apps/api/src/middleware/authenticate.ts` — `resolvePrincipal`: JWT path builds a user `Principal` (`:46-56`); users get all scopes. Provider is not consulted here.
- `apps/api/src/db/client.ts:61` — `withWorkspace`: sets the `app.current_workspace` GUC. Reference for the exact `set_config` call `signUp` must replicate.
- `apps/api/src/db/schema.ts` — `users` (`passwordHash` nullable, `:33-35`), `workspaces`, `workspaceMembers`, `subscriptions`. The four tables `signUp` writes.
- `packages/shared/src/schemas.ts:149-167` — `SignUpRequest` / `SignInRequest` / `AuthResponse`. The wire contract; don't drift from it.

## Playbook — add a managed provider (Clerk shown)

Goal: `AUTH_PROVIDER=clerk` boots and signs users up/in against Clerk while Iris still owns tenancy and sessions. Mirror `localAuthProvider` structure exactly; only the credential check differs.

**1. Write the impl.** New file `apps/api/src/auth/clerk-provider.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { subscriptions, users, workspaceMembers, workspaces } from '../db/schema';
import { newId } from '../lib/ids';
import { badRequest, unauthorized } from '../lib/errors';
import type { AuthedUser, AuthProvider } from './provider';

export const clerkAuthProvider: AuthProvider = {
  name: 'clerk',

  async signUp(db, input) {
    const email = input.email.trim().toLowerCase();
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (existing.length > 0) throw badRequest('An account with that email already exists', 'email_taken');

    // 1) Create the identity in the managed provider (their API owns the credential).
    //    const clerkUser = await clerk.users.createUser({ emailAddress: [email], password: input.password });
    // 2) Provision the Iris-local tenant. userId is IRIS's id (see gotchas), not clerkUser.id.
    const userId = newId();
    const workspaceId = newId();

    await db.transaction(async (tx) => {
      // users + workspaces are NOT workspace-scoped — no GUC needed for them.
      await tx.insert(users).values({
        id: userId,
        email,
        displayName: input.displayName,
        passwordHash: null,               // managed provider owns the credential (schema.ts:33)
        // add an external-id column if you need to map back to clerkUser.id
      });
      await tx.insert(workspaces).values({ id: workspaceId, name: `${input.displayName}'s workspace` });

      // Tenant-scoped inserts below are gated by RLS in prod — set the GUC FIRST.
      await tx.execute(sql`select set_config('app.current_workspace', ${workspaceId}, true)`);
      await tx.insert(workspaceMembers).values({ id: newId(), workspaceId, userId, role: 'owner' });
      await tx.insert(subscriptions).values({ workspaceId, plan: 'free', status: 'none' });
    });

    return { userId, workspaceId, email, displayName: input.displayName };
  },

  async signIn(db, input) {
    const email = input.email.trim().toLowerCase();
    // Verify with the managed provider instead of scrypt:
    //   const ok = await clerk.verifyPassword({ email, password: input.password });
    //   if (!ok) throw unauthorized('Invalid email or password');
    const rows = await db.select().from(users).where(eq(users.email, email));
    const user = rows[0];
    if (!user) throw unauthorized('Invalid email or password');

    const memberships = await db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, user.id)))
      .orderBy(workspaceMembers.createdAt);
    const workspaceId = memberships[0]?.workspaceId;
    if (!workspaceId) throw unauthorized('Account has no workspace');

    return { userId: user.id, workspaceId, email: user.email, displayName: user.displayName };
  },
};
```

**2. Register it** in `apps/api/src/auth/index.ts` — replace the throwing `case 'clerk':` with `return clerkAuthProvider;`.

**3. No route changes needed.** `/v1/auth/sign-up` and `/v1/auth/sign-in` already call `getAuthProvider().signUp/signIn(app.db, input)` and mint the Iris JWT themselves (`app.ts:117-129`). The `AuthedUser` you return flows straight into `signSession({ sub: userId, wid: workspaceId })`.

**4. Set env** `AUTH_PROVIDER=clerk` (+ your Clerk keys). Leave `local` as default so tests/offline dev keep working — ADR-004: "delete nothing."

**5. Verify** the full DoD flow still runs: sign-up → JWT → create note → sync. The tenant-isolation test (`tenant-isolation.test.ts`, ADR-003) must stay green; if it goes red your `signUp` provisioning drifted.

## Invariants & gotchas

- **`signUp` runs OUTSIDE `runTenant`.** There is no `Principal` yet, so the routes pass raw `app.db`, not a `Ctx`. Your `signUp` therefore **must set `app.current_workspace` itself**, inside its own transaction, **before** the tenant-scoped inserts (`workspaceMembers`, `subscriptions`). `users` and `workspaces` are *not* workspace-scoped, so they precede the `set_config` — copy `local-provider.ts:32-58` ordering exactly.
- **GUC name is `app.current_workspace`** (`client.ts:67`, `local-provider.ts:46`). ADR-003's prose says `iris.workspace_id` — **that text is stale; trust the code.** Getting the name wrong = RLS returns zero rows on a real cluster (silent, not an error).
- **ADR-004's interface is stale.** It describes `verifyCredentials`/`createUser`/`getPrincipal`. The real interface is `signUp`/`signIn` (`provider.ts:29-38`). Implement what the code says, not the doc.
- **Return Iris's local `userId`, never the provider's.** `signSession` puts it in `sub`; `resolvePrincipal` looks the user up by `claims.sub` in the `users` table (`authenticate.ts:46`). A Clerk/Supabase id in `sub` = every subsequent request 401s with "Session user no longer exists". Store the external id in a separate column if you need the mapping.
- **Sessions stay Iris JWTs by default.** The seam only covers the sign-up/sign-in boundary; `resolvePrincipal`→`verifySession` is hardcoded to Iris HS256 tokens. If you want the *provider* to own sessions (Clerk-issued JWTs sent on every request), that's a **bigger change**: you must also rewrite `verifySession`/`resolvePrincipal` to validate provider tokens and map claims→`Principal`. Don't assume flipping `AUTH_PROVIDER` does this.
- **`signIn`'s signature is password-shaped** (`{ email, password }`). Pure OAuth/magic-link flows don't fit it — they need a new route + method (e.g. a callback endpoint), not a hack through `signIn`. That's expected: OAuth is managed-provider territory (ADR-004).
- **Preserve the `HttpError` codes** for client parity: duplicate email → `badRequest(..., 'email_taken')`; bad creds / missing workspace → `unauthorized(...)`. The client and error handler (`app.ts:72-86`) key off these.
- **Provision all four rows, in order.** Missing `subscriptions` breaks billing reads; missing `workspaceMembers` makes `signIn` throw "Account has no workspace" (`local-provider.ts:81-83`) because it resolves the workspace via `memberships[0]`.
- **`passwordHash` is nullable** precisely so managed providers leave it `null` (`schema.ts:33`). Don't invent a placeholder hash.
- **Agent tokens are untouched.** `resolvePrincipal` routes `iris_at_…` bearer tokens through `verifyAgentToken` (`authenticate.ts:28-38`) — an Iris-native path independent of the auth provider. Swapping human auth does **not** change agent auth; don't try to route agents through Clerk/Supabase.
- **PGlite bypasses RLS** (superuser; `client.ts:55-59`). Your `set_config` in `signUp` is a no-op locally but load-bearing on a real non-superuser cluster. The app-layer `where workspace_id = …` filters are the primary guarantee; the GUC is defense in depth — set it anyway so prod behaves.
- **`getAuthProvider()` falls through to `local`** for any unrecognized `AUTH_PROVIDER` value (`index.ts:19-20`). A typo in the env var silently gives you local auth, not an error.
