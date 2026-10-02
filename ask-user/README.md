# Ask User

Registers the sequential, model-only `ask_user` tool for blocking clarification questions. Model-only exposure keeps the tool available to the model while preventing nested tool and codemode calls from opening a blocking user interaction.

- Multiple-choice questions take two to eight options and always include a custom-response option.
- In TUI mode, it uses a focus-aware custom component with configurable Pi selection keybindings and a multiline editor for custom responses. The component supports Pi 1.0's default fullscreen mode as well as regular mode.
  - Number keys 1–9 are intentional, fixed (non-remappable) shortcuts that pick a choice directly; the custom-response number opens the editor. Standard navigation, confirmation, cancellation, and editing continue to use Pi's configured keybindings.
  - The dialog uses at most three quarters of the terminal height (with a one-row minimum for exceptionally short terminals). When the question and choices do not fit, the choices scroll: up/down scroll the view while the selection is out of sight, up on the first choice scrolls back toward the start of the question, and Enter on a hidden selection brings it into view instead of choosing it. The selection page keys scroll by a page in regular mode; in fullscreen mode Pi uses those keys to scroll the transcript. For an open-ended question, up/down scroll the question until you start typing.
  - Leaving the custom-response editor with the cancel key returns to the choices and keeps the draft.
- In RPC mode, it uses standard `select` and single-line `input` dialogs so the active turn's abort signal can dismiss pending questions. As in the TUI, cancelling the custom-response input returns to the choices, and an empty response asks again.
- In JSON, print, or other non-UI modes, it returns an unavailable result rather than hanging.

Cancelling the dialog or aborting the active turn returns a cancelled result. After editing the extension, run `/reload` before interactive verification.
