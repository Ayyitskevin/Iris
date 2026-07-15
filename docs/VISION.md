# Iris — Vision

> Iris = the messenger (your agents carry work back to you) **and** iris = the eye
> (you watch and steer them). Herald + watcher. The name is the product thesis.

Iris is a notes-and-knowledge app for **solo operators who run AI agents alongside
themselves**. Think Notion's polish and Obsidian's data-ownership feel, rebuilt from
the ground up so that agents are **first-class citizens** of the system — not a chat
sidebar bolted onto a document editor.

It ships to **iOS, Android, and web from one codebase**. You install it on your phone.
It is a **multi-tenant SaaS**: we host it, you sign up, you sync instantly, there are no
servers for you to run. It costs **~$5/month**, deliberately matching Obsidian Sync's
price. We take Obsidian's sync business head-on — but the wedge is that **Iris is
agent-forward and Obsidian is not**.

## Who it's for (say this out loud before every decision)

**The solo operator.** One person who is a *conductor, not a doer.* Their scarce
resource is **attention**. They capture ideas, keep a knowledge base, and increasingly
hand work to AI agents.

Every design call optimizes for **one human supervising several agents** — not for a
team of humans collaborating. That single reframe is what separates Iris from Notion
(built for teams) and Obsidian (built for a lone human with no agents in the loop).

When a decision is ambiguous, ask: *does this help one person steer many agents while
spending the least attention possible?* If not, it is probably out of scope.

## The three pillars

The whole product is these three things, done well. Every schema, endpoint, and screen
should be traceable to one of them.

### 1. Ownership feel, without self-hosting

Users must feel their data is theirs — the way Obsidian users do — **even though we
host it.** Concretely:

- **Local-first.** The app works offline. Edits apply *instantly* to local state; sync
  reconciles in the background. The UI never blocks on the network.
- **Markdown is the native storage format**, not a lossy export. The editor is a *view
  over Markdown*, never a proprietary block tree.
- **One-tap full export** to plain Markdown + attachments, at any time, as a zip.

No lock-in is the marketing weapon against Notion. Matching Obsidian's price is the
weapon against Obsidian.

### 2. Agents as first-class actors

An agent is **not a chat bubble.** It is an actor with:

- an **identity** (its own principal, distinct from the human owner),
- a **scoped, revocable API token**, and
- an **audit trail**.

Agents read and write notes through the **same API the app uses**. Every agent action
is:

- **attributable** — who / which agent / when is recorded on every write,
- **reversible** — writes are versioned and undoable, and
- **bounded** — scoped permissions and rate limits.

The operator watches a **feed of what agents did** and can **undo any of it**. This is
the moat. Protect it in every schema decision — an action that cannot be attributed,
reversed, or bounded does not ship.

### 3. Sync that just works

Cross-device, conflict-aware, fast. This is the **paid feature** and the Obsidian
comparison point.

- **Invisible when it works** — you never think about it.
- **Honest when it can't** — conflicts are surfaced, never silently dropped. Iris would
  rather show you two versions and ask than lose a sentence you wrote.

## The sync wedge is the beginning, not the ceiling

Notes and trustworthy cross-device sync are the entry point. The full product is a
single operator graph that replaces the parts of Obsidian, Notion, Jira, and Confluence
that one person actually needs:

- **Knowledge** — Markdown pages, spaces, attachments, typed links/backlinks, search, and
  portable import/export.
- **Work** — projects and tasks with status, priority, due dates, dependencies, and one
  accountable human-or-agent assignee.
- **Agent control** — durable runs, bounded context, approvals, artifacts, lineage, and a
  review inbox. Activity is evidence of what happened; it is not allowed to masquerade
  as liveness or ownership.

These are views over one connected, local-first data model—not four mini-products taped
together. Iris is not chasing enterprise team administration or feature-count parity.
It is compressing a solo operator's knowledge, execution, and agent supervision into one
attention-efficient mobile surface.

## What "done" feels like

A new user installs Iris on their phone, signs up, and lands in *their own* isolated
workspace. They jot a note; it's saved before the network is even consulted. They open
the web app on a laptop and the note is there. They issue a token to an agent; the agent
files a note through the API; the note appears in their feed, attributed to that agent,
and they undo it with one tap — restoring the previous version. When they want out, one
tap hands them a zip of Markdown files. Five dollars a month.

That is the notes app that finally treats your agents like the coworkers they're
becoming, that you own your data in, and that lives in your pocket.
