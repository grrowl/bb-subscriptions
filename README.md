# Subscriptions for bb

A small bb plugin that follows GitHub PRs and Linear issues for a thread. GitHub is read through your existing authenticated `gh` CLI; Linear is read directly from its API with a **read-only** personal key. It stores the last observed state and sends a short thread message when something changes. An idle thread wakes; a busy thread gets a queued message.

```sh
bb subscriptions subscribe github owner/repo#123 owner/repo#124
bb subscriptions subscribe linear ENG-123 ENG-124
bb subscriptions unsubscribe github owner/repo#123
bb subscriptions unsub linear ENG-123 ENG-124
bb subscriptions list --json
```

`sub` / `unsub` are aliases. IDs can be separated by spaces or commas; PR and Linear issue URLs also work. Bulk commands accept up to 50 IDs for one platform and are validated before any subscription changes. Subscriptions are per thread, idempotent, and capped at 100 per thread. Outside a thread, pass `--thread <thread-id>`.

Agents can use the `thread_subscriptions` tool, with `action`, `platform`, and `ids`. This makes requests such as “subscribe linear ENG-123 ENG-124” work through the agent. The generated bb command help also exposes the CLI. The plugin adds no management panel: just a small “N following” count in the thread heading, with current states or errors on hover. The count is hidden when empty.

## Why a plugin?

`gh` and the Linear API already provide the reads. The missing part is a durable watcher that remains active after an agent turn and delivers a message into that same thread. This plugin supplies that lifecycle, subscription storage, retry behavior, thread deletion cleanup, and a small count.

A bb scheduled script plus `bb thread tell` is a valid alternative for a few fixed watches; native agent “wake on external change” is not required. For reusable bulk subscription commands and per-thread state, a thin plugin keeps those responsibilities together.

## Install

Requires bb >=0.42, SDK >=0.4.47, and an authenticated `gh` on the **bb server's PATH** (a CLI on a different enrolled machine is not used). Linear needs no CLI: create a personal API key and set it as a plugin secret.

```sh
npm ci
bb plugin build
bb plugin install . --yes
```

### Linear API key

In Linear open **Settings → Account → Security & access → Personal API keys** and create a key. **Only the Read permission is needed**; you can also limit the key to the teams you will follow. Then:

```sh
bb plugin config subscriptions set linearApiKey lin_api_…
```

The key is stored as a plugin secret (a 0600 file under the plugin data directory), never in the database or the browser. The plugin sends one read-only GraphQL query per check and never writes to Linear or GitHub, and registers no webhooks. If Linear refuses to let you create a key, a workspace admin has disabled member keys under Administration → API.

Optional settings:

```sh
# Enables bare PR numbers outside a project thread, e.g. subscribe github 123 124.
# In a project thread, this is inferred from its GitHub remote automatically.
bb plugin config subscriptions set githubRepository owner/repo
bb plugin config subscriptions set intervalSeconds 60
```

## Behavior

- Checks due items every five seconds, with a default per-item interval of 60 seconds (configurable 30–3600). First successful read establishes a silent baseline. `list` shows pending/error until it succeeds.
- GitHub: open/draft/closed/merged, commit, review decision, latest review, check rollup, assignees, labels and comments.
- Linear: status, assignee, priority, labels and latest comment. A changed update timestamp without a specific field difference produces “updated”.
- Example: `[Subscription update] [owner/repo#123](https://github.com/owner/repo/pull/123): open → merged; checks: pending → success.`
- Unchanged snapshots do not send. Failed reads/sends retain the previous baseline and back off, up to an hour. `gh` processes have 20-second timeouts and are cancelled on shutdown/reload.
- Each sweep makes one batched Linear request per 50 due issues, and at most four concurrent `gh` calls. A Linear `RATELIMITED` reply, or fewer than 100 requests left in the hourly window, pauses all Linear checks until the window resets (Linear allows 2 500 requests per user per hour, shared across all of that user's keys). A missing or rejected key pauses Linear for an hour; changing any setting lifts the pause immediately.
- Lookups are shared for identical items in each sweep, and each thread is looked up once per sweep. Delivery is serialized against unsubscribe and checks subscription identity after fetching, so removing a subscription prevents a stale lookup from sending.
- SQLite state survives reload/restart. Archived threads pause checks; deleted threads lose their subscriptions. Subscriptions remain after a PR merges or issue completes, so reopening is observable.

This is polling of **observed state**, not a complete event log: intermediate transitions between checks, older comment edits, and changes made and reverted while bb is offline may not be reported. Label lists are bounded to 100, PR assignees to 50. Checks run only while bb is running and the plugin is enabled. Heavy subscription loads or provider failures delay delivery. A crash between accepting a thread message and persisting its snapshot can produce a duplicate on retry; the current SDK send operation has no idempotency key.

## Development

```sh
npm ci
npm run typecheck
npm test
bb plugin build
# Optional read-only live smoke tests. Linear needs a key in the environment:
SUBSCRIPTIONS_LIVE=1 LINEAR_API_KEY=lin_api_… npm test -- providers.live.test.ts
```

If every server test fails with "Could not locate the bindings file", `npm ci` did not fetch a `better-sqlite3` binary for your Node version. Run `npx prebuild-install` inside `node_modules/better-sqlite3` (or `npm rebuild better-sqlite3`) once.

Tests cover bulk/scoped commands, normalization, silent baselines, change delivery, failed-send retry, unsubscribe races, batched lookups, provider pauses, Linear request shape and rate-limit handling, archived/deleted threads, reload persistence, backoff, public SDK imports, and the heading count. The opt-in live tests read one PR authored by the current GitHub account and one accessible Linear issue; they change neither provider nor thread state.

### Adding a service

Implement the `Provider` interface from `providers/types.ts` in a new file under `providers/` (ID normalisation, a batched `fetch` that maps into the generic `Snapshot`, and any settings it needs, prefixed with the provider id), then add it to the `providers` array in `providers/index.ts`. The platform enum, settings page, CLI help, and agent tool description are all derived from that array.
