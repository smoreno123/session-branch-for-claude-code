# Session Branch for Claude Code

Running several [Claude Code](https://code.claude.com) sessions in VS Code, each on its own branch or worktree? This extension shows **the git branch of the Claude Code session you are looking at**, right next to VS Code's own git branch indicator.

```
⎇ main*   ✨ feature/login ⚠
  │          └── branch of the active Claude Code session (yellow when it differs)
  └── branch of the workspace folder (VS Code's built-in git)
```

So at a glance you know both **which branch the folder is on** and **which branch the session is working on**.

## Features

- **Follows the active tab**: switch between Claude Code tabs and the indicator updates instantly.
- **Mismatch warning**: the item turns yellow with a ⚠ when the session's branch differs from the workspace folder's branch.
- **Worktree aware**: sessions started in a git worktree, or that enter one mid-session (Claude Code's `EnterWorktree`), show the worktree's live branch with a "fork" icon.
- **Follows where Claude works**: Claude's shell returns to the session folder after every command, so it often works in another worktree with `cd ../repo-feature && …`. The item shows the branch of the repo where Claude last ran a command or edited a file, not just the folder the session was started in.
- **Multi-repo sessions**: when a session also works in other repositories (files it reads or edits, `cd` / `git -C` in shell commands), the item shows `+N` and the hover lists every repo with its live branch, whether it is a regular checkout or a worktree.
- **Hover for details**: session title, session branch, folder branch, session working directory (and the branch it is on right now) and session ID.
- **Click** to copy the branch name or the session ID.
- Keeps showing the last active session while you edit regular files, and refreshes every few seconds in case the session switches branch.

## How it works

Claude Code stores each session as a local transcript in `~/.claude/projects/<project>/<session-id>.jsonl`. Every entry records the session's working directory and git branch, and the transcript also contains the session title shown on the tab.

The extension matches the active Claude Code tab's title (including titles truncated with `…`) against those transcripts, and reads the last recorded branch.

## Privacy

Everything happens **locally**. The extension only reads transcript files on your machine and runs `git rev-parse` in your folders. It sends nothing anywhere and has no telemetry.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `claudeBranchStatus.maxAgeDays` | `30` | Only sessions modified in the last N days are considered. |

## Commands

- **Session Branch: Show Session Info** (also on click)
- **Session Branch: Refresh**

## Known limitations

- Only Claude Code **editor tabs** are detected, not the Claude Code sidebar view.
- Other repos are detected from the paths that appear in the transcript, so a repo the session only read a file from also counts. At most 10 repos are listed.
- Sessions are matched by tab title. If two sessions share the same title, the most recent one in the current workspace wins.
- The main branch is the live branch of the repo where Claude last ran a shell command or edited a file. Reading files does not count. If the session has not done either yet, the branch recorded in its last message is shown.
- It relies on Claude Code's local transcript format and tab type, which are not a public API. If a future Claude Code release changes them, the item shows `?` until this extension is updated.

## Disclaimer

This is an unofficial, community extension. It is not affiliated with, endorsed by or supported by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.

## License

[MIT](LICENSE)
