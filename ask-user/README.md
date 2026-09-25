# Ask User

Registers the sequential `ask_user` tool for blocking clarification questions.

- In TUI mode, it uses a focus-aware custom component with configurable Pi selection keybindings and a multiline editor for custom responses.
- In RPC mode, it uses standard `select` and single-line `input` dialogs so the active turn's abort signal can dismiss pending questions.
- In JSON, print, or other non-UI modes, it returns an unavailable result rather than hanging.
- Multiple-choice questions always include a custom-response option.

Cancelling the dialog or aborting the active turn returns a cancelled result. After editing the extension, run `/reload` before interactive verification.
