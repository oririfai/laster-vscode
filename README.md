# Laster — review what your AI agent changed

Laster highlights, in real time, every code change **you did not make yourself**: edits from Claude Code, Codex, Gemini CLI, Aider, Cline, Continue, Copilot, scripts, anything. Then it lets you review them one by one and **Approve** or **Revert** each change.

It works in any folder: **no git, no commits, no push required.**

<!-- Screenshot / GIF: add media/screenshot.png (or a GIF) and reference it here. -->

## Why

AI agents write straight into your files. `git diff` only helps if the project uses git, and even then it mixes your own edits with the agent's. Laster keeps its own snapshot of what you last saw, and shows only what changed behind your back.

## How it works

1. An agent changes your code. The changed files appear in the **Pending Review** panel, grouped into time-based batches, and are marked in the explorer.
2. Open a file: added and changed lines are **green**, deleted lines get a **red marker** (`⊖ 3 lines deleted`). Hover a change to see the previous code, or peek it inline.
3. For each change, choose:
   - **✓ Approve**: the highlight disappears and the change becomes the new baseline.
   - **↺ Revert**: the code goes back to how it was (undoable with Ctrl/Cmd+Z).
4. When every change in a file is reviewed, the file drops off the list.

Your own edits are never highlighted, even when you edit a file the agent is still changing.

## What counts as "not you"

| Change | Tracked? |
|---|---|
| Files written from outside VSCode (CLI agents, scripts, codegen) | ✅ |
| Edits made inside VSCode by extensions (Cline, Continue, Copilot Edits, …) | ✅ |
| Inline suggestions accepted with Tab / Cmd+→ (Copilot, Codeium, NES, …) | ✅ the text was written by AI |
| **Paste as AI Code** (for code copied from a chat in the browser) | ✅ |
| Your typing, undo/redo, paste, format, rename, quick fix | ❌ |
| Git operations (checkout, pull, reset, stash, …) | ❌ the Git extension already covers them |

Laster is deliberately **aggressive**: when it cannot prove that an edit was yours, it treats it as AI. It is easier to approve one of your own edits than to miss an agent's. Batches that may be your own edits are labeled *"maybe your edits?"* and have a **Mark as My Edit** button.

## Where to find things

- **Pending Review panel** (Laster icon in the activity bar): batches → files → changes, with Approve / Revert / Diff buttons at every level.
- **Explorer and tabs:** files pending review get a **C** badge, and every folder above them gets a **•**.
- **In the editor:** a CodeLens above each change (`✓ Approve | ↺ Revert | ⊙ Peek`), a hover with the previous code, and **Approve ▾ / Revert ▾** dropdowns in the editor title bar (*This File* / *All Files*).
- **Status bar:** the number of files pending review.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Alt+]` / `Ctrl+Alt+[` | Next / previous change (across files) |
| `Ctrl+Alt+Enter` | Approve the change at the cursor |
| `Ctrl+Alt+Backspace` | Revert the change at the cursor |

## Keybindings Laster takes over

To tell your edits apart from AI edits, Laster routes a few built-in keybindings through itself. **Their behavior does not change**: Laster only records who made the edit, then runs the original command.

| Keys (macOS / Windows & Linux) | Original command | Why | Setting |
|---|---|---|---|
| `Tab` (while a suggestion is visible) | Accept inline suggestion | Marks the accepted text as AI | `laster.trackInlineSuggestions` |
| `Cmd+→` / `Ctrl+→` (while a suggestion is visible) | Accept next word | Same | `laster.trackInlineSuggestions` |
| `Cmd+V` / `Ctrl+V` | Paste | Counts a large paste as yours | `laster.wrapUserCommands` |
| `Shift+Alt+F` (Linux: `Ctrl+Shift+I`) | Format Document | Counts formatting as yours | `laster.wrapUserCommands` |
| `Cmd+K Cmd+F` / `Ctrl+K Ctrl+F` | Format Selection | Same | `laster.wrapUserCommands` |
| `Shift+Alt+O` | Organize Imports | Same | `laster.wrapUserCommands` |
| `F2` | Rename Symbol | Counts multi-file renames as yours | `laster.wrapUserCommands` |
| `Cmd+.` / `Ctrl+.` | Quick Fix | Counts quick fixes as yours | `laster.wrapUserCommands` |

If this conflicts with Vim or your own keybindings, turn the setting off. The only effect is that those edits may then be flagged for review.

## Settings

| Setting | Default | Description |
|---|---|---|
| `laster.excludeFolders` | `node_modules`, `.git`, `dist`, `out`, `build`, … | Folder names that are never tracked |
| `laster.maxFileSizeKB` | `1024` | Larger files are not tracked |
| `laster.maxSnapshotMB` | `200` | Limit for the initial snapshot of the workspace |
| `laster.trackEditorEdits` | `true` | Track in-editor edits that are not proven to be yours |
| `laster.trackInlineSuggestions` | `true` | Mark accepted inline suggestions as AI (takes over Tab / Cmd+→) |
| `laster.wrapUserCommands` | `true` | Take over Paste / Format / Rename / Quick Fix so they count as yours |
| `laster.explorerDecorations` | `true` | Show the **C** / **•** markers in the explorer and on tabs |

## Privacy

Everything stays on your machine. To show what changed, Laster keeps compressed copies of your workspace files (the baseline) in VSCode's own per-workspace storage folder. That folder is **outside your project**, so agents can't read or modify it and it never ends up in git. Laster makes no network requests and collects no telemetry.

## Known limitations

- Accepting an inline suggestion with the mouse (the suggestion toolbar) is not tracked; Tab and Cmd/Ctrl+→ are.
- Paste / Format / Rename started from a menu or the Command Palette (instead of their keybinding) may be flagged for review.
- A small in-editor agent edit right next to your cursor looks like typing and is not flagged.
- Creating, copying, or deleting files in the explorer shows up for review.
- Git operations performed while VSCode is closed show up for review when it reopens.
- Moving or renaming the project folder resets the review state.

## License

[Apache-2.0](LICENSE)
