# Installing the intake skill

For the product team member handing this to a stakeholder: fill in the
repository name below, grant the stakeholder's GitHub account issue-create
access (triage) on that repository, and send them this folder with the two
prerequisites done or done together on a call.

Target repository: `<owner>/<repo>` (the operator fills this in — the skill
reads everything else from that repo's intake rules file).

## Prerequisites (once, any OS)

1. A GitHub account, with access granted by the product team.
2. The `gh` CLI installed — <https://cli.github.com> — then `gh auth login`
   (choose GitHub.com, login with browser).

## Claude Code

Copy this folder to `~/.claude/skills/intake/`, restart Claude Code, then
type `/intake` and name the scope (for example: `/intake crm`).

## Codex (or another agentic harness)

Any harness that can run shell commands works. Point the harness at
`SKILL.md` as its instructions — for Codex, add a line to your `AGENTS.md`
(or paste at session start):

> Follow the instructions in <path-to>/intake/SKILL.md. Target repository:
> <owner>/<repo>. Scope: crm.

## เริ่มต้นใช้งาน (สำหรับผู้ให้ข้อมูล)

1. เปิดโปรแกรม (Claude Code หรือ Codex) ตามที่ทีมติดตั้งให้
2. พิมพ์เริ่มบทสนทนา แล้วบอกหัวข้อที่ต้องการเล่า เช่น "crm"
3. ตอบคำถามทีละข้อเป็นภาษาไทยได้เลย เล่าจากงานจริงที่ทำอยู่
4. ก่อนบันทึก ระบบจะสรุปให้อ่านยืนยันก่อนทุกครั้ง แก้ได้จนกว่าจะตรง
5. เมื่อยืนยันแล้ว ระบบจะบันทึกเป็นรายการคำขอให้ทีมพัฒนา ทีมจะตามถาม
   เพิ่มเติมในรายการนั้นโดยตรง
