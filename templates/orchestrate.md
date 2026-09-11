# <Project> agent rules

Copy this template to `.agent/orchestrate.md` only when you set up a repo. Fill in
each required value and delete notes that do not apply. Normal agent runs read
the copied repo file, not this template. Do not copy the worker or review
process from the shared skills into the repo file.

## Repo and delivery

- Remote: `<name and URL>`.
- Default branch: `<name>`.
- Git host: `<GitHub or other>`.
- Delivery: `<GitHub PR | commit and push only>`.
- Draft first: `<yes | no>`. With yes, the worker opens a draft and the TL
  marks it ready after the final check.
- Identity: `<bot and token source | user's current login>`.
- Package tool and lockfile: `<names and rules>`.

## Hook settings

Delete this section unless the repo opts out of a shared hook.

- watch_guard: `<off | delete this line>`

## Work areas

- `<path>`: `<area>` and `<label>`
- `<path>`: `<area>` and `<label>`

Areas: `<none | names>`. If the repo has more than one, a TL chooses one before
it sends work.

## Worktree settings

- The main checkout belongs to `<person>`. Agents may run `git fetch origin`
  there and make no other change.
- Worktree folder or harness setting: `<value>`.

## Read before work

Read these files in order:

1. `<AGENTS.md or README.md>`
2. `<product plan>`
3. `<decision records>`
4. `<task progress>`
5. `<writing-rules overlay — required before any doc edit; see
   templates/writing-rules.md in the skills repo>`

Read only the files that exist and that the changed paths need.

## Agents

- Harness: `<Codex | Claude Code | other>`.
- Project agent files: `<paths>`.
- Worker types in order: `<one or more types, first to last>`.
- Reviewer type: `<type>`.
- At most `<number>` workers may run at once. The manager and reviewers do not
  count toward this project limit.

Provider files choose models and effort. The repo file names logical agent types.
Do not copy model names from another harness.

## Checks

Run these commands for changed paths and their users:

```sh
<type check command>
<lint command>
<test command and exact runner>
<build command if needed>
```

Known command limits: `<facts or none>`.

## Review

- Checklist: `<path>`.
- Mechanical scan: `<script | checklist table>`.
- Reviewer verdict goes to: `<PR review | return block>`.
- Proof of checks: `<CI | local gate and its result path>`.
- Ready check: `<command the gh wrapper runs before pr ready | none>`.
- Security bar: ASVS level `<1 | 2 | 3>`.
- Blocking findings: `<severities or rules that prevent PASS>`.
- Nonblocking findings: `<severities, required action, or none>`.

## PRs

Delete this section when delivery stops after commit and push.

### Labels

| Changed paths    | Label     |
| ---------------- | --------- |
| `<path>`         | `<label>` |
| `<product docs>` | `<label>` |
| `<agent rules>`  | `<label>` |

### Title and body

- Title form: `<form>`.
- Body sections: `<goal, reason, decisions, open questions, artifacts>`.
- Use `Resolves #N` for each issue the merge closes.
- Do not add file lists, diff counts, or check marks when the host already
  shows them.
- Keep one change in each PR.

### Artifacts

- `<changed paths>` require `<artifact, command, and safe data rule>`.
- Open and inspect each required artifact before delivery.

### Status

- PR and CI status source: `<gh | local service and paths>`.
- After the user merges, check `<issue and board actions>`.

## Tickets

- Tracker: `<GitHub Projects | none | service a person updates>`.
- Board: `<name and ID>`.
- Title form: `<form>`.
- Required fields: `<problem, scope, acceptance rules, open questions, ...>`.
- Milestones: `<rules>`.
- Link blocked work with `<tracker feature>`.

Search tickets, open PRs, and remote branches before you create a ticket or
send work. Read each new ticket number from the create command output.

## Worker code rules

The worker reads these from `origin/<default>`; the prompt links, never pastes:

- `<banned API or required shared library>`
- `<style rule>`
- `<data, time, money, language, or privacy rule>`

## TL rules

- UI work needs this approved design record: `<path or none>`.
- Engineering decision records go in `<path>`.
- The TL may update ticket state only when `<automation>` fails.

## PM rules

- Product docs go in `<path>`.
- Engineering decisions go in `<path>` and belong to the TL.
- Design rules: `<path or none>`.
- Design work: `<steps and approval>`.
- Outside requirement sources: `<paths or services>`.
- Keep this data out of the repo and tracker: `<rules>`.

## PM session start

Delete this section if the PM needs no set start steps.

1. Read `<saved notes>`.
2. Read `<progress docs>` from the remote default tip.
3. Check `<cheap PR source>`.
4. Report open work, active PRs, design choices, dates, and a first task.

Extra session files: `<session bus, comment cursor, or none>`.

## TL session start

Delete this section if the TL needs no set start steps.

1. Read `<saved notes>`.
2. Read `<progress docs>` from the remote default tip.
3. Check `<cheap PR source>`.
4. Read ready tickets only when the TL plans to send work.
5. Report open work, active PRs, blocked tasks, dates, and a first task.

Extra session files: `<session bus, comment cursor, or none>`.
