# plan quota

Footer status showing Kimi Code and OpenAI Codex plan quotas:

```
kimi 5h:54%(10:03am) wk:41%(sat 9:03pm) | oai 5h:78%(1:32am) wk:19%(tue 12:04am)
```

Kimi is polled from `GET https://api.kimi.com/coding/v1/usages`. OpenAI is
initialized from `GET https://chatgpt.com/backend-api/wham/usage`, then updated
from the `x-codex-*-used-percent`, window, and reset headers on normal model
responses; after the first header update, the extension stops polling OpenAI.

`%` = used, reset times in local timezone. A provider turns warning-colored
when any window has ≤15% remaining. A trailing `?` marks stale data.

## Install

Symlink into pi's extension dir (same pattern as the sibling extensions):

```bash
mkdir -p ~/.pi/agent/extensions/kimi-quota
ln -sf "$PWD/index.ts" ~/.pi/agent/extensions/kimi-quota/index.ts
```

Then `/reload` (or restart pi). The segment appears after the first fetch.

## Configuration

| Variable             | Default | Meaning                                                                                          |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------ |
| `QUOTA_POLL_SECONDS` | `60`    | Poll interval; `0` disables polling (refreshes after agent turns continue, throttled to 20s) |

Credential source: `~/.pi/agent/auth.json` → `kimi-coding` (`key` or `access`)
and `openai-codex` (`access` and `accountId`). A missing credential leaves that
provider dimmed.
