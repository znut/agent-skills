# bgh — bot-identity gh wrapper

`bgh <anything gh takes>` = `GH_TOKEN=$(cat <repo's token file>) gh <anything>`.

Kills the per-command inline-prefix boilerplate that the review-gate hook's
bot-identity guard demands, without weakening the guard: bare mutating `gh`
stays blocked; `bgh` is bot-authored by construction.

## Install (once per machine)

```sh
ln -s ~/src/agent-skills/tools/bgh/bgh ~/.local/bin/bgh
```

## Configure (once per repo)

Token resolution is **per-repo** via machine-local git config — different
repos/orgs use different bot identities, and worktrees inherit automatically
because they share the main `.git/config`:

```sh
cd <repo>
git config agent.bot-token-file '~/.config/<bot>.token'
```

No config → clear error (never silently falls back to the human login).
One-call override: `BGH_TOKEN_FILE=<path> bgh …`.

## Hook interplay

The review-gate hook's bot-identity guard anchors on literal `gh` at command
position, so `bgh` invocations pass untouched and bare mutating `gh` still
blocks. The guard's error message names `bgh` as the preferred fix.
