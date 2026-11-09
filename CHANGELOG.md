# Changelog

## 1.1.0

- Sessions that enter a git worktree mid-session are followed: Claude Code moves the transcript to the worktree's project folder, and the extension now finds it there, also while a non-Claude tab is active. The worktree's live branch is shown with a "fork" icon.
- Follows where Claude is actually working: when it runs commands in another repo or worktree (`cd ../repo-160 && …`) or edits files there, that repo's live branch is shown instead of the branch of the folder the session was started in.
- Multi-repo sessions: other repositories the session works in (local checkouts or worktrees) are counted in the status bar (`+N`) and listed with their live branches in the hover and in **Show Session Info**.

## 1.0.0

- First public release.
- Status bar item with the git branch of the active Claude Code session, next to the built-in git branch.
- Yellow warning when the session branch differs from the workspace folder branch.
- Matches tabs whose titles Claude Code truncates with `…`.
- Hover details and click-to-copy branch / session ID.
