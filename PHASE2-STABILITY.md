# NekoAI v0.4.29 — Phase 2 Model Picker

This build closes the Phase 2 Model Picker stabilization without changing the Home, Provider Connection flow, GitHub, or Plan behavior.

## Phase 2 guarantees

- Chat model picker groups models by connected and active provider.
- Disabled providers do not appear in the chat picker.
- Disabled models do not appear in the chat picker.
- The management modal keeps connected providers visible even when disabled.
- Model management keeps model switches available for connected providers.
- Search is contained inside the picker and does not inherit global input sizing.
- The model list owns its vertical scrolling; wheel events remain inside the model list.
- The picker footer remains centered with `Gerenciar modelos`.
- Selecting a model closes the picker and updates the current selection.
- If the currently selected model becomes unavailable, the first available active model is selected.
