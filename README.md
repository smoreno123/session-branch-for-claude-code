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
- **Worktree aware**: sessions started inside a git worktree show that worktree's branch.
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
- Sessions are matched by tab title. If two sessions share the same title, the most recent one in the current workspace wins.
- The branch shown is the one recorded in the session's last message. Sessions that `cd` into a worktree (instead of being started in it) record the branch of the folder they were started in.
- It relies on Claude Code's local transcript format and tab type, which are not a public API. If a future Claude Code release changes them, the item shows `?` until this extension is updated.

## Disclaimer

This is an unofficial, community extension. It is not affiliated with, endorsed by or supported by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.

## License

[MIT](LICENSE)
