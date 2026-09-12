# Subscriptions

Follow GitHub pull requests and Linear issues from a bb thread. Ask your agent to “subscribe linear ENG-123 ENG-124”, or use `bb subscriptions sub github owner/repo#123`.

The plugin uses your existing authenticated `gh` and `linear` CLIs on the bb server. It periodically compares state, sends concise updates to the subscribing thread, and wakes idle agents. Bulk subscribe/unsubscribe, persistent subscriptions, retry backoff, and archived-thread pausing are included.

A small count in the thread heading shows how many items you follow. Hover for states, or run `bb subscriptions list`. There is no management panel or separate provider login.
