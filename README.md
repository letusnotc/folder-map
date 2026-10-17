# folder-map

A Claude Code mod that opens a side panel whenever Claude edits a file. The panel shows:

- the project's folder tree
- every file Claude edited, numbered in the order it was first edited (with `×N` for repeat edits and `new` for files Claude created)
- a highlighted trail from the project root down to the file being edited right now

`/folder-map` shows or hides the panel.

Works in the terminal (text tree with box-drawing guides) and in the desktop app's Code tab (drawn tree).

## Requirements

Claude Code 2.1.287 or later.

## Install

At the prompt of a Claude Code terminal session:

```text
/plugin install folder-map --marketplace letusnotc/folder-map
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```bash
claude plugin install folder-map --marketplace letusnotc/folder-map
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `letusnotc/folder-map`, then **Add plugin**.

## Use

- Ask Claude to edit something. The panel opens on its own.
- `/folder-map` toggles the panel.
- Panel buttons:
  - **Edited branches / Full tree**: show only the folders that hold edits, or the whole tree.
  - **Auto-open**: turn auto-opening on edits on or off.
  - **Refresh**: rescan the folders.
- Closing the panel yourself keeps it closed for further edits in that same folder, and it opens again when Claude edits somewhere else.

Heavy folders (`node_modules`, `.git`, `dist`, `build`, `.venv`, and similar) are listed but never opened. Large trees are capped so the panel stays fast.

## Access

What the mod uses:

- **Reads**: folder listings and file-exists checks (`$.fs.list`, `$.fs.exists`) under the project being edited, to draw the tree.
- **Hooks**: `Edit`, `Write`, `MultiEdit` and `NotebookEdit` tool calls. It only notes the file path after the edit runs and never changes or blocks a tool call.
- **UI**: one side pane and the `/folder-map` command.
- **No** file writes, process runs or network access.

## Development

```bash
claude plugin validate .
claude plugin test .
```

Run it from a local folder with `claude --plugin-dir ./folder-map`.

## License

[MIT](LICENSE)
