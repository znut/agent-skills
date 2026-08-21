# kimi-quota

Footer status segment showing the Kimi Code coding-plan quota, polled from
`GET https://api.kimi.com/coding/v1/usages` (the endpoint the kimi.com/code
console uses; readable with the plain `kimi-coding` API key — no OAuth dance,
no browser scraping).

```
5h:54%(10:03am) wk:41%(sat 9:03pm)
```

`%` = used, reset times in local timezone. Turns warning-colored when the
shortest window has ≤15% remaining. A trailing `?` marks a stale value (last
fetch failed, showing the previous snapshot).

## Install

Symlink into pi's extension dir (same pattern as the sibling extensions):

```bash
mkdir -p ~/.pi/agent/extensions/kimi-quota
ln -sf "$PWD/index.ts" ~/.pi/agent/extensions/kimi-quota/index.ts
```

Then `/reload` (or restart pi). The segment appears after the first fetch.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `KIMI_QUOTA_POLL_SECONDS` | `60` | Poll interval; `0` disables polling (refreshes still happen after agent turns, throttled to 20s) |

Credential source: `~/.pi/agent/auth.json` → `kimi-coding` (`key`, or OAuth
`access`). No credential → segment stays dim (`quota:…`).
