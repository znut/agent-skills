---
name: intake
description: Interview a stakeholder in their own language and file their needs as GitHub issues for the product team. Runs on the stakeholder's machine with only the gh CLI — no repository clone, no build tools. Trigger: "/intake", "stakeholder interview", "requirements intake".
---

# Stakeholder intake

Turn a conversation with a stakeholder into well-formed GitHub issues the
product team can review and schedule. This skill runs on the stakeholder's
OWN machine under their OWN GitHub login. It needs the `gh` CLI and nothing
else: no repository clone, no package manager, no build tools.

This file is the generic layer. The target repository supplies the specific
layer — labels, title form, language, template, scopes — in its intake rules
file. The rules file wins over this file on any conflict.

## Start

1. Check `gh auth status`. If it fails, help the person through
   `gh auth login` (browser flow) before anything else. Do not continue
   without a working login.
2. The install note that came with this skill names the target repository
   (`<owner>/<repo>`). Fetch its intake rules from the remote — no clone:

   ```
   gh api repos/<owner>/<repo>/contents/.agent/intake.md -H "Accept: application/vnd.github.raw"
   ```

   If that path does not exist, try `.claude/intake.md` the same way. If
   neither loads, stop and show the exact error for the person to relay to
   the product team.
3. Ask which scope the person wants to talk about. The rules file lists the
   open scopes; the person may name one up front (for example "crm").

## Interview

- Speak the stakeholder's language — the rules file names it. One question
  at a time. Short questions, no software jargon.
- Cover, in whatever order the conversation allows:
  - who has the problem, and what they do about it today;
  - where it goes wrong, and what that costs (time, money, mistakes);
  - what a good outcome would look like — something the person could SEE;
  - who else touches this flow;
  - roughly how often it happens and at what volume;
  - anything the current tool does that must not be lost;
  - what the person considers out of scope.
- Keep exact quotes for anything involving money, counts, or rules.
- Do not design solutions, estimate effort, or promise scope or dates. If
  asked, say the product team reviews every request and follows up on the
  issue itself.
- Several small needs make several issues. One shippable need per issue.

## File

1. Draft each issue using the rules file's template, title form, and labels.
2. Show the person a summary in their language. Adjust until they agree it
   says what they mean.
3. Create the issue:

   ```
   gh issue create -R <owner>/<repo> --title "<title>" --body-file <draft> --label <labels>
   ```

   Read the created URL from the command output and show it.
4. Finish by listing every issue link created, and say the product team will
   ask follow-up questions on the issue itself.

## Hard rules

- Never clone the repository, never push code, never edit repository files.
- Never promise scope, dates, or acceptance. Issues are requests, not
  commitments.
- Create issues only in the configured repository, only with the labels the
  rules file names, and never touch milestones or project boards.
- On any tool failure, stop and show the exact error text for the person to
  relay to the product team.
