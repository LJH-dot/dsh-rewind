# dsh-rewind

Claude Code-style `/rewind` for DSH Web, with git-aware file restore and vault recovery.

## Install

```bash
dsh plugin --profile web add dsh-rewind --registry https://registry.npmjs.org/
```

Restart DSH Web afterwards.

## Commands

### `/rewind`

- Bare `/rewind` + Enter opens a popup listing the latest user messages; pick one to rewind.
- `/rewind <n>` rewinds directly. `1` is the latest user message.
- Rewind means: restore to **before** that user message was sent. The selected message is removed from the conversation and its original text is put back into the composer.

Scopes:

| Command | Conversation | Files |
|---|---|---|
| `/rewind <n>` | reverted | reverted |
| `/rewind <n> --conversation` | reverted | untouched |
| `/rewind <n> --code` | untouched | reverted |

### `/unrewind`

Pure bare command (no arguments). It undoes the latest `/rewind` and hard-overwrites the conversation from that rewind's vault backup. The recovery anchor is displayed as the original user prompt, not as a special marker.

## File restore

- A git snapshot (`HEAD` + uncommitted changes via `git stash create`) is taken before every real user message.
- `/rewind` restores files to that snapshot with `git reset --hard` + `git stash apply`.
- If a workspace is not a git repository (or has no commits yet), the plugin automatically runs:

  ```bash
  git init
  git add -A
  git -c user.name=dsh-rewind -c user.email=dsh-rewind@local commit --allow-empty -m "dsh-rewind baseline"
  ```

  before taking the first snapshot. Existing git repositories are never touched.

### Limitations

- Snapshots are keyed by user message, not by individual tool call.
- The whole repository working tree is restored, including changes made outside DSH tools.
- The snapshot does not include untracked files; newly created untracked files may remain after a rewind.
- The workspace must be a git repository with at least one commit for file restore to work. The automatic baseline setup covers this for normal workspaces.

## Model context

Rewind/unrewind cutover nodes are empty-content `assistant/message` replacement events. DSH's `deriveEventMessage` skips empty assistant messages, so no `/rewind`, `/unrewind`, vault-path, or marker text ever enters the model context.

## Development

```bash
cd <plugin-source-dir>
dsh plugin --profile web remove dsh-rewind
dsh plugin --profile web add file:<plugin-source-dir>
```

## License

MIT
