---
name: agent-actors-and-tokens
description: Open when issuing, hashing, scoping, verifying, or revoking agent tokens, debugging agent 401/403s, or adding/changing agent scopes.
---

## When to use

- Adding, renaming, or narrowing an agent **scope** (e.g. splitting `notes:write` into `notes:delete`).
- An agent token returns **401** ("Invalid or revoked agent token") or **403** ("This token lacks the required scope") and you need to trace why.
- Changing the token **format**, hashing, or the issue/list/revoke endpoints (`/v1/agents/tokens`).
- Anything touching **who** an actor is: the `Principal` model, attribution in the activity log / note versions, or "why isn't `agent_tokens` under RLS?".
- Adding a new route and deciding between `requireScope(ctx, ...)` (agent-reachable) vs `requireUser(ctx.principal)` (human-only).

## Mental model

An agent token is a bearer credential shaped `iris_at_<tokenId>_<secret>`. The **tokenId** is a plaintext UUID that indexes the `agent_tokens` row in O(1); the **secret** is 32 random bytes that are *never stored* — only a scrypt hash is. So a stolen database yields zero usable tokens. Verification (`verifyAgentToken`) has to run **before** we know which workspace a request belongs to — the token itself tells us the workspace — so `agent_tokens` (like `users`) is deliberately **not** under Postgres RLS; it is an auth-bootstrap table, kept safe by always filtering on `workspace_id` at the app layer. Once verified, an agent and a human user collapse into one `Principal{type,id,name,workspaceId,scopes}`; every downstream service treats them identically, except users implicitly hold all scopes while an agent holds exactly what its token granted. That single `name` is what shows up, verbatim and attributable, in every `activity_log` and `note_versions` row — the product's whole "agents are accountable actors" pillar rides on it.

## Key files

- `apps/api/src/services/agents.ts` — the core. `TOKEN_PREFIX='iris_at_'`, `formatToken()`, `isAgentToken()`, `issueAgentToken()`, `listAgentTokens()`, `revokeAgentToken()`, `verifyAgentToken()`, and the `VerifiedAgent` shape.
- `apps/api/src/lib/hash.ts` — `hashSecret()` / `verifySecret()`. Node scrypt, `KEYLEN=64`, 16-byte salt, self-describing string `scrypt$<saltHex>$<hashHex>`, constant-time `timingSafeEqual`. Shared with password hashing.
- `apps/api/src/lib/ids.ts` — `newId()` = `randomUUID()` (the tokenId); `newSecret(32)` = `randomBytes().toString('base64url')` (the secret).
- `apps/api/src/middleware/authenticate.ts` — `resolvePrincipal(db, authHeader)`: `isAgentToken` branch → `verifyAgentToken`; else JWT → `users` lookup. Builds the `Principal`.
- `apps/api/src/auth/provider.ts` — `Principal` interface (the unified identity). `scopes` field, `name` comment "used verbatim in the activity log".
- `apps/api/src/context.ts` — `Ctx{db,principal,workspaceId}` and `requireScope(ctx, scope)` (throws 403; users always pass).
- `apps/api/src/db/schema.ts:agentTokens` (lines 95-107) — columns: `tokenHash`, `tokenPrefix`, `scopes` jsonb, `lastUsedAt`, `revokedAt`.
- `apps/api/migrations/0001_init.sql:108-135` — the RLS block, and the explicit note (lines 116-119) on why `users`/`agent_tokens` are excluded.
- `apps/api/src/serialize.ts:serializeAgentToken` — row → wire; **omits `tokenHash`**. The one place secrets could leak; they don't.
- `apps/api/src/app.ts:200-224` — the three token routes, all `requireUser` (agents cannot mint/list/revoke tokens).
- `packages/shared/src/schemas.ts` — `AgentScope` enum (line 19), `IssueAgentTokenRequest`/`Response` (line 213+). Extensionless imports; `AgentScope` is the single source of truth for the scope set.

## Playbook

**Most common task: add a new scope (worked example — `notes:delete`).** Scopes live in exactly one enum and are enforced per-route. Nothing in the token machinery changes.

1. **Add the value to the shared enum** — `packages/shared/src/schemas.ts:19`:
   ```ts
   export const AgentScope = z.enum(['notes:read', 'notes:write', 'notes:delete']);
   ```
   This is the whole type surface: `agent_tokens.scopes` is `jsonb('scopes').$type<AgentScope[]>()`, so the DB and the typed client both pick it up. No migration needed (jsonb).

2. **Grant it to users implicitly.** Users must never be blocked by a scope. Add it in the two places that hard-code the user scope set:
   - `apps/api/src/middleware/authenticate.ts:55` → `scopes: ['notes:read', 'notes:write', 'notes:delete']`
   - Grep for the same literal array anywhere else (e.g. mobile `settings.tsx` pre-checks the issue form) and update the UI list too.

3. **Enforce it on the route** — `apps/api/src/app.ts`, in the relevant `tenant(req, async (ctx) => {...})`:
   ```ts
   app.delete('/v1/notes/:id', guarded, (req) =>
     tenant(req, async (ctx) => {
       requireScope(ctx, 'notes:delete');   // was 'notes:write'
       // ...
     }),
   );
   ```

4. **Verify the boundary with a test** — mirror `apps/api/test/agent-undo.test.ts:108` ("enforces token scopes and revocation"): issue a token *without* the new scope, hit the route, assert `403`; issue *with* it, assert success.

That's it. Issuance is generic (`issueAgentToken` just stores whatever `scopes[]` you pass, validated by `IssueAgentTokenRequest` which only checks `AgentScope.min(1)`), and verification is scope-agnostic.

**Reference: the token lifecycle (for debugging).**

- **Issue** (`issueAgentToken`, user-only route): `tokenId=newId()`, `secret=newSecret()`, `tokenHash=await hashSecret(secret)`, insert row, return `{ token: formatToken(tokenId,secret), agentToken: serialize(...) }`. The plaintext `token` is returned **once** and never recoverable.
- **Present**: client sends `Authorization: Bearer iris_at_<id>_<secret>`.
- **Verify** (`verifyAgentToken`, pre-tenant, on the base db): `isAgentToken` prefix check → split `rest` at the **first** `_` (`sep=rest.indexOf('_'); if (sep<=0) return null`) → `SELECT ... WHERE id=tokenId AND revoked_at IS NULL` → `verifySecret(secret, row.tokenHash)` → best-effort `lastUsedAt` stamp (failure ignored) → return `VerifiedAgent`. **Any** failure returns `null` → `resolvePrincipal` throws `unauthorized` → 401.
- **Revoke** (`revokeAgentToken`): soft delete — `UPDATE ... SET revoked_at=now() WHERE id AND workspace_id AND revoked_at IS NULL RETURNING id`; 0 rows → `notFound`. Next `verifyAgentToken` misses the `revoked_at IS NULL` filter → 401.

## Invariants & gotchas

- **Never store or log the plaintext secret.** Only `hashSecret()` output goes in `token_hash`. `serializeAgentToken` must never add `tokenHash`/secret to the wire type. `tokenPrefix` is a cosmetic display hint (`iris_at_<8chars>…`) and is intentionally too short to reconstruct anything.
- **The secret separator is the FIRST `_`, not the last.** `verifyAgentToken` uses `rest.indexOf('_')`. `tokenId` is a UUID (`randomUUID()`, contains no `_`), and the base64url secret can contain `-`/`_`. If you ever change `newId()` to a format containing `_`, verification silently breaks — keep the id `_`-free.
- **`agent_tokens` is intentionally NOT under RLS** (migration lines 116-119). Do not "fix" this by adding a policy: verification must read the row before any workspace context exists. Its isolation guarantee is the app-layer `WHERE workspace_id = ctx.workspaceId` in `listAgentTokens`/`revokeAgentToken`. Never write an `agent_tokens` query that omits that filter (except `verifyAgentToken`, which is pre-tenant by design and scoped by the unguessable secret).
- **Revocation is soft and one-way.** Row stays for the audit trail; `revoked_at` is set once. Re-revoking a revoked token → `notFound` (the `isNull(revokedAt)` guard), which is correct idempotent-ish behavior, not a bug.
- **Users bypass `requireScope` by construction** — they hold `['notes:read','notes:write']` from `resolvePrincipal`. So `requireScope` only ever gates agents. To make a route human-only (token issuance, undo, billing, device registration), use `requireUser(ctx.principal)` (in `app.ts`) — a scope check alone will not stop an agent from having equivalent access.
- **Agents cannot manage tokens.** All three `/v1/agents/tokens` routes call `requireUser`. Keep it that way — an agent minting its own broader token would defeat the bounded-actor pillar.
- **`principal.name` is attribution, not decoration.** It is written verbatim into `note_versions.author_name` and `activity_log.actor_name` (`services/note-write.ts:36-47`). For agents it is `agent_tokens.agent_name`. Renaming an agent does **not** rewrite history (append-only log) — that is intended.
- **scrypt is CPU-bound and async.** `hashSecret`/`verifySecret` are `await`ed; every agent request pays one `verifySecret` on the hot path. Don't move it into a tight loop or call it per-row. If you swap the KDF, keep the `scrypt$salt$hash` self-describing format so old hashes still verify (or write a migration).
- **`lastUsedAt` failures must never block a request** — the update is wrapped in `try/catch {}` on purpose. Preserve that; a stamp write failing is not an auth failure.
