# Subscriptions for bb

A small bb plugin that follows GitHub PRs and Linear issues for a thread. It reads through your existing authenticated `gh` and `linear` CLIs, stores the last observed state, and sends a short thread message when something changes. An idle thread wakes; a busy thread gets a queued message.

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

The CLIs already provide the provider integrations. The missing part is a durable watcher that remains active after an agent turn and delivers a message into that same thread. This plugin supplies that lifecycle, subscription storage, retry behavior, thread deletion cleanup, and a small count.

A bb scheduled script plus `bb thread tell` is a valid alternative for a few fixed watches; native agent “wake on external change” is not required. For reusable bulk subscription commands and per-thread state, a thin plugin keeps those responsibilities together.

## Install

Requires bb >=0.42, SDK >=0.4.47, authenticated `gh` and `linear` commands on the **bb server's PATH**. CLIs on a different enrolled machine are not used. Verified with Linear CLI 2.5.0 (`linear api --variables-json`).

```sh
npm ci
bb plugin build
bb plugin install . --yes
```

No separate API token setup is needed. Provider commands only make read queries. The plugin does not register webhooks or write to GitHub or Linear.

Optional settings:

```sh
# Enables bare PR numbers, e.g. subscribe github 123 124
bb plugin config subscriptions set githubRepository owner/repo
# Selects an authenticated Linear workspace; otherwise uses the CLI default
bb plugin config subscriptions set linearWorkspace workspace-slug
bb plugin config subscriptions set intervalSeconds 60
```

## Behavior

- Checks due items every five seconds, with a default per-item interval of 60 seconds (configurable 30–3600). First successful read establishes a silent baseline. `list` shows pending/error until it succeeds.
- GitHub: open/draft/closed/merged, commit, review decision, latest review, check rollup, assignees, labels and comments.
- Linear: status, assignee, priority, labels and latest comment. A changed update timestamp without a specific field difference produces “updated”.
- Example: `[Subscription update] owner/repo#123: open → merged; checks: pending → success. https://github.com/owner/repo/pull/123`
- Unchanged snapshots do not send. Failed reads/sends retain the previous baseline and back off, up to an hour. Recognized CLI rate-limit errors wait at least 15 minutes. CLI processes have 20-second timeouts and are cancelled on shutdown/reload.
- Lookups are shared for identical items in each sweep. Delivery is serialized against unsubscribe and checks subscription identity after fetching, so removing a subscription prevents a stale lookup from sending.
- SQLite state survives reload/restart. Archived threads pause checks; deleted threads lose their subscriptions. Subscriptions remain after a PR merges or issue completes, so reopening is observable.

This is polling of **observed state**, not a complete event log: intermediate transitions between checks, older comment edits, and changes made and reverted while bb is offline may not be reported. Label lists are bounded to 100, PR assignees to 50. Checks run only while bb is running and the plugin is enabled. Heavy subscription loads or provider failures delay delivery. A crash between accepting a thread message and persisting its snapshot can produce a duplicate on retry; the current SDK send operation has no idempotency key.

## Development

```sh
npm run typecheck
npm test
bb plugin build
# Optional read-only live smoke test using your existing CLI accounts:
SUBSCRIPTIONS_LIVE=1 npm test -- providers.live.test.ts
```

Tests cover bulk/scoped commands, normalization, silent baselines, change delivery, failed-send retry, unsubscribe races, shared lookups, archived/deleted threads, reload persistence, backoff, public SDK imports, and the heading count. The opt-in live test reads one PR authored by the current GitHub account and one accessible Linear issue; it changes neither provider nor thread state.
