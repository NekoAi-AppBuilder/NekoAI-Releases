# v0.4.51 — Branch, permission and build execution stabilization

- Compact all Neko modals to 600px max width.
- Prevent `origin`, `HEAD`, and `origin/HEAD` from appearing as selectable branches.
- Pin OpenCode HTTP event/session/permission calls to the active project directory.
- Add legacy permission reply fallback.
- Keep permission polling active even if the busy event arrives late.
- Handle `session.idle` and `retry` events.
- Add stale-busy recovery by checking completed assistant messages.
- Keep Plan approval/build execution flow unchanged semantically.
