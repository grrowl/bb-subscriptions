# Design notes — icon, direct Linear API, provider plugins, improvements

Written 2026-09-14 against bb 0.43.0 / SDK 0.4.47 (host SDK is 0.4.84).

## 1. Icon

`bb.branding.icon` accepts either a **named host glyph** or a plugin-relative
SVG path. The named vocabulary in the bb 0.43 app bundle has 49 entries:

```
AlertCircle AlertTriangle Archive Bot Bug Check ChevronDown ChevronLeft
ChevronRight Circle CircleCheck CircleQuestion CircleX ClosePluginPane
CloseThreadPane Code ComputerTerminal01 Copy Download Edit Folder Folder02
FolderExport FolderGit FolderPlus FolderSync FolderUnknown Info ListTodo
Loading MessageCirclePlus MessageQuestion MessageSquare MessageSquarePlus
MoreHorizontal PanelLeft Search SectionAdd Settings SlidersHorizontal Spinner
Target Terminal ToolCase Toolbox Trash2 UserRoundPlus Workflow Zap
```

`Bell` is not in it, so the previous manifest rendered the fallback `Zap`.
Nothing in that list says "follow/subscribe", so the plugin now ships its own
glyph at `assets/icon.svg` (an RSS-style feed mark, `currentColor` stroke, no
fill, no doctype — the shape the host validator wants). Alternatives if the
feed mark reads wrong in the sidebar: a bell with a dot, or an eye.

## 2. Linear: personal API key instead of the `linear` CLI

### Why

- The CLI is a process spawn per check (20 s timeout, `execFile`, stderr
  regex for rate limits). A `fetch` is cheaper, cancellable via the same
  `AbortSignal`, and gives structured rate-limit information.
- The CLI must be installed **and logged in** on the bb server's PATH. A key
  in plugin settings removes that install step and works on a headless host.
- The `--workspace` flag is only needed because a CLI login can hold several
  workspaces. A key is bound to one workspace, so the setting goes away.

### API facts (verified against linear.app/developers, 2026-09-14)

| Item | Value |
|---|---|
| Endpoint | `POST https://api.linear.app/graphql` |
| Auth header (personal key) | `Authorization: <key>` — no `Bearer` prefix |
| Auth header (OAuth) | `Authorization: Bearer <token>` (not needed here) |
| Key creation | Settings → Account → Security & access → Personal API keys |
| Key scoping | Permissions: Read, Write, Admin, Create issues, Create comments. Can also be limited to specific teams. |
| Rate limit (per user, not per key) | 2 500 requests/h, 3 000 000 complexity points/h, 10 000 points per query |
| Rate-limit signal | HTTP **400** with `errors[].extensions.code === "RATELIMITED"`; headers `X-RateLimit-Requests-Remaining`, `X-RateLimit-Requests-Reset` (epoch ms) |

**Only a read-only key is needed.** The plugin runs a single `issue` query and
never mutates. Tell users to tick only **Read** when creating the key, and to
limit it to the teams they will follow. Admins can disable member key creation
workspace-wide; if `bb plugin config subscriptions set linearApiKey` is
refused by Linear, that toggle is the reason.

### Budget check

Default interval 60 s, 100 subscriptions per thread cap. Worst case, one
thread at cap: 6 000 requests/h — over the 2 500/h quota. Realistic loads
(5–20 issues) are 300–1 200/h, under quota but not by a wide margin, and the
quota is shared with anything else that user does through the API. Two
mitigations, in order of value:

1. **Batch per sweep.** One query with `issues(filter: { id: { in: [...] } })`
   (or aliased `issue(id:)` fields) fetches every due Linear item in a single
   request. This turns N requests into 1 per sweep and is what Linear's docs
   ask polling clients to do ("don't poll each issue individually").
2. **Read the headers.** When `X-RateLimit-Requests-Remaining` drops below a
   floor (say 200), push every Linear item's `due` out to
   `X-RateLimit-Requests-Reset`. That replaces the current 15-minute guess.

### Settings

```ts
linearApiKey: { type: 'string', label: 'Linear personal API key (read-only is enough)', secret: true },
```

`secret: true` stores the value in a 0600 file under the plugin data dir,
never in the db and never sent to the frontend. It has no `default`, so
`settings.get()` returns `string | undefined` and the provider must treat
"missing" as a configuration error with a clear message, not a lookup error.

Remove `linearWorkspace`. Keep the CLI path only if a migration period is
wanted: "key set → HTTP, else → CLI". Simpler is to drop the CLI outright and
bump the minor version; the README already says the plugin is 0.1.x.

### Transport

```ts
const res = await fetch('https://api.linear.app/graphql', {
  method: 'POST', signal,
  headers: { 'content-type': 'application/json', authorization: key },
  body: JSON.stringify({ query: linearQuery, variables: { id } }),
});
```

Error mapping:

| Condition | ProviderError | retryMs |
|---|---|---|
| key unset | "Linear API key not set: `bb plugin config subscriptions set linearApiKey …`" | 3600 s (no point retrying sooner) |
| 401 / `AUTHENTICATION_ERROR` | "Linear key rejected — regenerate a read-only key" | 3600 s |
| 400 + `RATELIMITED` | "Linear rate limit; waiting until reset" | `reset − now`, min 60 s |
| 5xx / network | generic, keep baseline | existing backoff |
| `data.issue === null` | "Issue not found or not visible to this key (check team scope)" | existing backoff |

The same query string works unchanged; `linear api` was already sending it to
this endpoint. The `issueSchema` and snapshot mapping stay as they are.

### GitHub

Same reasoning applies: `gh api graphql` could become `fetch` to
`https://api.github.com/graphql` with a fine-grained PAT (read-only
`pull_requests` + `metadata` on selected repos). That is a follow-up; `gh` is
far more commonly installed than `linear` and its auth story is better.
Keeping `gh` for now and going direct for Linear is a reasonable asymmetry as
long as the provider interface (below) hides it.

## 3. Making it provider-plugin shaped

Today `providers.ts` is one `fetchSnapshot(platform, …)` with `if (platform
=== 'github')` branches, and `model.ts` has a matching `canonical()` switch.
`platformSchema` is a hard-coded enum used by the RPC, CLI, agent tool, and
the DB column. Adding a service means touching five places.

### Target shape

```ts
// providers/types.ts
export interface Provider {
  /** DB/CLI/agent-tool identifier, e.g. 'github' | 'linear' | 'jira'. */
  id: string;
  /** Human label and example ID for help text and error messages. */
  label: string; example: string;
  /** Settings this provider needs, merged into bb.settings.define(). */
  settings: Record<string, SettingDescriptor>;
  /** Normalise user input (ID, URL, bare number) or throw with a usable message. */
  canonical(raw: string, ctx: { config: Config; repository?: string }): string;
  /** Read current state. Throw ProviderError with retryMs on failures. */
  fetch(id: string, ctx: { config: Config; signal: AbortSignal }): Promise<Snapshot>;
  /** Optional: fetch many at once. Falls back to per-item fetch. */
  fetchMany?(ids: string[], ctx): Promise<Map<string, Snapshot | ProviderError>>;
  /** Optional: provider-specific diff wording. Default is model.describe(). */
  describe?(id: string, before: Snapshot, after: Snapshot): string | null;
}
```

```
providers/
  types.ts        Provider interface, ProviderError
  registry.ts     const providers = [github, linear]; byId(); platformSchema = z.enum(ids)
  github.ts       gh (or PAT) implementation
  linear.ts       API-key implementation
```

`server.ts` then:

- builds `platformSchema` from the registry instead of `model.ts`;
- spreads every provider's `settings` into `bb.settings.define()`;
- in `poll`, groups due rows by provider and calls `fetchMany` when present
  (this is where the Linear batching above lands for free);
- generates the CLI usage string and agent-tool description from
  `providers.map(p => p.id)` so help text never drifts.

`model.ts` keeps `Snapshot`, `Subscription`, and the generic `describe()`.
`canonical()` moves into each provider; the GitHub remote inference
(`githubRepositoryFromRemote`) is GitHub-specific and goes with it.

### What a new service costs afterwards

One file implementing `Provider`, one line in `registry.ts`, one test. No
changes to RPC, CLI, agent tool, DB schema (the `platform` column is already
free text), or the frontend.

### Things to keep in mind

- **Snapshot stays generic.** `fields: Record<string,string>` is what makes
  `describe()` provider-agnostic. Providers should map into it rather than
  extend it.
- **Settings namespacing.** Prefix provider settings (`linearApiKey`,
  `githubRepository`) to avoid collisions; the registry can enforce it.
- **Schema drift.** Keep provider zod schemas next to the query in the same
  file so they change together.
- **Per-provider rate state.** The registry can hold a `pausedUntil` per
  provider (from rate-limit headers) that `poll` consults before fetching.
  Today the pause is per subscription row, so a rate-limited provider keeps
  getting hit by every other row until each one fails individually.

Candidate next providers with cheap read-only tokens: GitHub Issues (same
query shape as PRs), GitLab MRs, Jira Cloud (basic auth with API token),
Notion pages, Vercel deployments.

## 3b. Delivery: one live message per thread

Observed in a real thread: five updates for one PR in two hours, three of
them queued back-to-back while the agent was busy, two of them bare
"updated". Fixes, all in 0.3.0:

- `describe()` no longer emits "updated" for an `updatedAt` bump with no
  tracked field change.
- Changes are recorded in a `pending` table keyed by thread, holding the
  oldest unseen baseline per item, and flushed after `debounceSeconds`
  (default 10) as one message built from baseline → current snapshot.
- A queued send (`delivery: "queued"`) stores the row id and `updatedAt`.
  While that row waits, later changes call
  `threads.queuedMessages.update` with `expectedUpdatedAt` to rewrite it in
  place. `message.dispatched` and `message.cancelled` clear the bookkeeping
  so the next change starts from a fresh baseline. A failed update (row gone
  or edited) falls back to a normal send.
- Thread-busy detection is bb's: `queue-if-active` decides. The plugin never
  inspects thread status.

Open question for the bb team: the thread log labelled these
`queue-if-active` messages "steer" when the thread was active.

## 4. Improvements noticed along the way

Ordered by how much they matter. Status as of the 0.2.0 commit: items 1, 2, 3,
7, 8, 9, 10, 11, 12 and 13 are done; sections 2 and 3 above are implemented
(`providers/`), with GitHub still read through `gh`. Open: 4, 5, 6, 14, and
the GitHub PAT transport.

1. **Per-row rate limiting is wrong-shaped.** One rate-limited fetch delays
   only that row; the other 99 rows still fire in the same sweep. Needs a
   per-provider pause (see above).
2. **Sequential polling.** `poll` awaits each row in turn, so 100 rows × up to
   20 s each can take 30+ minutes per sweep and the 60 s interval becomes
   meaningless under load. Group by provider, batch where possible, and cap
   concurrency (e.g. 4 in flight) otherwise.
3. **`threads.get` per row per sweep.** The archived-thread check calls the
   SDK once per row; cache per thread per sweep alongside the snapshot cache.
4. **Wall-clock `due` survives sleep.** After a laptop sleeps, every row is
   overdue and fires at once. Fine at small scale; worth a jitter when
   batching is added.
5. **Duplicate sends on crash.** README already notes there is no send
   idempotency key. Persisting a "pending message" row before `threads.send`
   and clearing it after would let restart skip an already-sent update at
   the cost of one extra write.
6. **`intervalSeconds` change resets every row's `due` and `failures`.**
   Changing any setting (including the API key) triggers a full sweep of all
   rows immediately. Acceptable, but with a key change that is desirable
   whereas with an interval change a stagger would be kinder to quotas.
7. **Comment detail is thin.** GitHub reports only comment count and last
   `updatedAt`; Linear only the last comment timestamp. Including the author
   login/name of the latest comment costs nothing extra in the query and
   makes "comments: 3 → 4" actionable.
8. **Message format.** The prefix `[Subscription update]` is fine for agents
   but every message also ends with a bare URL. bb renders Markdown, so
   `[o/r#123](url)` would be a nicer read in the thread.
9. **`--json` is only documented for `list`** in the usage string but the
   parser accepts it for subscribe/unsubscribe too. Either document or reject.
10. **No plugin skill.** The SDK guide asks plugins to document their commands
    in a `skills/` directory so agents pick up usage without guessing.
    `bb.skills` is `[]`.
11. **SDK pin is stale.** `bb plugin build` reports the host SDK at 0.4.84
    versus the pinned 0.4.47; `bb plugin types` updates it. The
    `experimental_` slot names may have been stabilised since.
12. **Tests need a native build step.** `npm ci` on Node 22.23 left
    `better-sqlite3` without a binary and all server tests failed until
    `prebuild-install` ran in the package directory. A `postinstall` hint or
    a note in the README would save the next person twenty minutes.
13. **Dense one-line style.** Several 300+ character lines (`fetchSnapshot`
    return, the CLI `run` body). Splitting the provider code per file
    (section 3) addresses most of this naturally.
14. **`PLUGIN_OVERVIEW.md` duplicates the README** and will drift. Consider
    making it the source for the marketplace blurb only.
