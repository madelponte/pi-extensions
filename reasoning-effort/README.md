# Reasoning effort

Change the current model's reasoning effort without restarting pi.

## Commands

- `/effort` — open a selector containing only the levels supported by the current model
- `/reasoning` — alias for `/effort`
- `/effort high` — set a level directly
- `/reasoning off` — set a level directly

The selector marks the current level with `●`. Unsupported levels are rejected rather than silently clamped.

Because this directory is under `~/.pi/agent/extensions`, run `/reload` in an existing pi session after installing or changing it. Future pi sessions discover it automatically.
