# tools/hooks — optional enforcement gate

`review-gate.js` is a PreToolUse (Bash) hook for Claude Code that enforces, per repo:

1. **Bot-identity guard** — every mutating `gh` invocation must carry an inline `GH_TOKEN=` prefix (for repos operating tools through a dedicated bot account).
2. **Review marker** — PR creation is blocked unless the `review-gate` skill PASSed and pinned a sha marker to the branch tip (commits after review invalidate it).
3. **Verify marker** — same freshness check for the repo's local verify gate (`scripts/verify-mark.sh` pattern).

**The hook enforces all guards by default.** A person may turn off a guard in
the `## Hook settings` section of `.agent/orchestrate.md`:

```markdown
## Hook settings

- bot_identity: off
- review_marker: off
- verify_marker: off
```

Anything but `off` keeps the guard on. A missing file, section, or key also
keeps it on. `/orchestrate` asks the user for these values. An agent must not
choose `off`.

The hook reads `.agent/orchestrate.md` first. If that file has no settings
section, it checks the old `## Enforcement policy` section in
`.claude/orchestrate.md`.

Install: copy `review-gate.js` somewhere stable (e.g. `~/.claude/hooks/`) and register it in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$HOME/.claude/hooks/review-gate.js\"",
            "timeout": 5,
            "statusMessage": "review-gate"
          }
        ]
      }
    ]
  }
}
```

Notes:

- The hook fails OPEN on errors (non-repo, unreadable files) except where blocking is the explicit purpose. Skills work without the hook — it is enforcement, not function.
- Known false-positive class: prose in a shell command (heredoc bodies, commit messages) containing a backtick followed by a mutating `gh` phrase can trip the identity guard. It fails in the block direction — reword the prose, use `--body-file`, or write the file with a non-shell tool.
