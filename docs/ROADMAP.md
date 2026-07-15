# Iris — Roadmap & Deferred Work

This file exists so that scope discipline is *visible*. The brief lists explicit
non-goals for the foundation and asks that anything we're tempted to add be written down
here instead of smuggled into the vertical slice. Everything below is **intentionally not
built yet.**

## Non-goals for the foundation (resisted on purpose)

These were named as out of scope and are staying out until the foundation is proven:

- **Real-time multi-human co-editing.** Would justify a CRDT text type (see ADR-005). Our
  single-operator conflict model (version-based, surfaced) is correct until then.
- **Teams / roles / permission schemes** beyond one owner per workspace. The membership
  table exists as a *seam* (a `workspace_members` row with a `role` column defaulting to
  `owner`), but invites, multiple roles, and org management are not built.
- **Block editor / databases / tables** (Notion parity). The editor is a Markdown view,
  full stop.
- **AI generating content inside Iris.** We *expose* agents via API; we do not ship a
  model. No inference runs in Iris.
- **Plugins / marketplace.**
- **Desktop-native apps.** (Web covers desktop for now.)
- **Graph view / backlinks polish.**

## Documented seams (built to be extended, not extended yet)

- **Auth provider** — `AuthProvider` interface with a local implementation; Clerk/Supabase
  drop in behind it (ADR-004).
- **Workspace membership** — `workspace_members(role)` is present; multi-user/roles land here.
- **Token scopes** — `notes:read` / `notes:write` today; finer scopes (per-folder, admin)
  extend the same `scopes` array.
- **Organization primitive: folders** — chosen over tags for the foundation; tags can be
  added as an orthogonal table without touching notes.

## Near-term follow-ups (first things after the foundation ships)

1. **Managed auth provider** wired for real (Clerk or Supabase) + password reset + OAuth +
   email verification — these are the managed provider's job, not `LocalAuthProvider`'s.
2. **Attachment storage** to object storage (S3/R2) with the same export guarantee;
   foundation stores attachment metadata and includes files in export, but a production
   blob store + upload flow is a follow-up.
3. **Harden the local-first sync**: batching/backoff tuning, tombstone GC, large-workspace
   initial-sync pagination, and per-field (not per-note) conflict surfacing for long notes.
4. **Rate limiting** for agent tokens beyond the coarse fixed-window limiter (per-scope
   budgets, sliding window, 429 semantics).
5. **Stripe hardening**: proration, plan changes, dunning, customer portal, tax.
6. **EAS Build + store submission** pipeline and OTA update channels.
7. **Editor upgrades**: live Markdown preview, slash-menu, image paste — still emitting
   plain Markdown.
8. **Full-text search** over notes (Postgres `tsvector` first; a dedicated index later).

## Tempted-but-parked ideas (write here, don't build)

- Backlinks / `[[wikilink]]` graph — fits the product, but polish is a non-goal now.
- Agent "runs" grouping (a batch of agent actions as one undoable unit) — natural
  extension of the activity log; parked until the single-action feed is proven in use.
- Per-workspace encryption-at-rest keys for a stronger "you own your data" story.
- Webhooks so agents can *subscribe* to note changes (today they poll the change-feed).
