# NekoAI v0.4.17 — Fase 1

## Connect / Disconnect / Provider state

- Provider connect/disconnect now uses OpenCode provider credential endpoints directly (`PUT /auth/:providerID` and `DELETE /auth/:providerID`).
- Avoids the SDK MCP `auth.remove()` route that caused `MCP server not found: {name}`.
- Disconnect invalidates the OpenCode instance and verifies the provider is no longer reported as connected.
- Connecting an already-connected provider is idempotent and does not overwrite its credential.
- Renderer refuses to open the API-key form for an already-connected provider.
- Provider/model selection is refreshed so a disconnected or disabled model cannot remain selected.

## Future GitHub phase

The GitHub clone phase must preserve a real authenticated `git clone` path for private repositories; the ZIP fallback must not replace the authenticated Git clone behavior.
