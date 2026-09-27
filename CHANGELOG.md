# Changelog

## 0.3.0

- Track edits made **inside VSCode** by extensions (Cline, Continue, Copilot Edits, …), using a very aggressive classifier: an edit counts as yours only when it is typing at a cursor, undo/redo, or a wrapped user command.
- Inline suggestions accepted with Tab / Cmd+→ (Copilot, Codeium, NES, …) are marked as AI.
- **Paste as AI Code** command (Command Palette and editor context menu).
- Paste, Format, Organize Imports, Rename, and Quick Fix run through Laster so their edits count as yours.
- Agents that edit and save right away are still caught; reloads from disk and "Revert File" are not flagged.
- The Pending Review panel groups changes into time-based **batches → files → changes**, with Approve / Revert at every level.
- **Mark as My Edit** for batches that may be your own edits.
- Explorer and tab markers: **C** on files pending review, **•** on every folder above them.
- Approve ▾ / Revert ▾ dropdowns in the editor title bar (*This File* / *All Files*).
- New settings: `laster.trackEditorEdits`, `laster.trackInlineSuggestions`, `laster.wrapUserCommands`, `laster.explorerDecorations`.

## 0.2.0

- Your own edits in a file that has pending AI changes are no longer highlighted.
- Per-change **Approve / Revert** from a CodeLens, the hover, or the keyboard.
- Per-word highlights inside changed lines.
- **Peek** the previous code inline.
- Keyboard navigation between changes across files.
- A file leaves the list on its own once you tidy it back to its reviewed state.
- Very large diffs no longer cause high CPU usage.

## 0.1.0

- First version: changes written to disk by anything other than you (CLI agents, scripts) are highlighted green (added/changed) and marked red (deleted).
- Hover to see the previous code; open a side-by-side diff.
- Pending Review panel with Approve / Revert per file and for all files.
- Git operations are recognized and not flagged.
- The baseline is stored outside the project, in VSCode's workspace storage.
