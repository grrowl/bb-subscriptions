---
name: subscriptions
description: Follow GitHub pull requests and Linear issues from this thread; get a short message when one changes.
---

# Subscriptions

Use the `thread_subscriptions` tool (or `bb subscriptions`) when the user asks to follow, watch, subscribe to, or stop watching a PR or issue.

- `platform` is `github` or `linear`. IDs: `owner/repo#123` (or a PR URL, or a bare number inside a project with a GitHub remote), `ENG-123` (or an issue URL). Up to 50 IDs per call, 100 per thread.
- Subscribing is idempotent. The first successful check is a silent baseline; later changes arrive as `[Subscription update] …` messages in this thread. Changes are coalesced: one message per thread covering everything since you last read one, so a message may list several items or several changes to one item.
- `list` shows each item's last state or its current error. "waiting for first check" is normal for about a minute after subscribing.
- Linear needs a personal API key in plugin settings (`bb plugin config subscriptions set linearApiKey …`). Only the **Read** permission is required. If every Linear item reports "API key not set" or "rejected", that setting is the fix; do not retry in a loop.
- A "rate limit" or "budget" error pauses that platform until Linear's hourly window resets. Nothing is lost; the next check runs after the pause.
- GitHub reads go through the `gh` CLI on the bb server; "gh lookup failed" means it is not installed or not logged in there.
