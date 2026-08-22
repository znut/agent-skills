# pi extensions

This directory contains extensions for the [`pi`](https://github.com/earendil-works/pi-coding-agent) coding-agent harness.

| extension | path | purpose |
|-----------|------|---------|
| subagent  | `pi/extensions/subagent/` | spawn isolated pi worker/reviewer processes and signal the parent |
| kimi-quota | `pi/extensions/kimi-quota/` | footer segment with Kimi Code plan quota (`5h:N%(reset) wk:M%(reset)`), polled from `/coding/v1/usages` |
| web-search | `pi/extensions/web-search/` | `web_search` + `fetch_url` custom tools (DuckDuckGo, zero-dep, SSRF-guarded) |

See each extension's README for install and usage instructions.
