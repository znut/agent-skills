# pi extensions

This directory contains extensions for the [`pi`](https://github.com/earendil-works/pi-coding-agent) coding-agent harness.

| extension  | path                        | purpose                                                                        |
| ---------- | --------------------------- | ------------------------------------------------------------------------------ |
| subagent   | `pi/extensions/subagent/`   | `spawn_agent({task, size})`: drawn worker model → worktree → fresh cross-provider review loop → PR/branch, one run row logged; also plain process spawning + parent signalling |
| plan-quota | `pi/extensions/plan-quota/` | OpenAI plan quota footer (`oai 5h:… wk:…`)                                    |
| ant-budget | `pi/extensions/ant-budget/` | Anthropic credit left this cycle, a local tally of pi's recorded cost (`ant $…/200 →21 Nov`); header comment holds the settings |

See each extension's README for install and usage instructions.
