# Subscriptions

Follow GitHub pull requests and Linear issues from a bb thread. Ask your agent to “subscribe linear ENG-123 ENG-124”, or use `bb subscriptions sub github owner/repo#123`.

The plugin uses your existing authenticated `gh` CLI on the bb server and a read-only Linear personal API key. It periodically compares state, sends concise updates to the subscribing thread, and wakes idle agents. Bulk subscribe/unsubscribe, persistent subscriptions, retry backoff, and archived-thread pausing are included.

A small count in the thread heading shows how many items you follow. Hover for states, or run `bb subscriptions list`. There is no management panel. The only setup is the Linear key, which needs only the Read permission.
