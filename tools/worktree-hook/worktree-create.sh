#!/usr/bin/env bash
# WorktreeCreate hook — agent worktrees go in the sibling <repo>-worktrees/
# dir, OUTSIDE the repo: repo-wide tooling never sweeps nested checkouts and
# a worktree's relative paths can't escape into the primary tree.
# stdin: harness JSON · stdout: created path ONLY · created DETACHED at the
# fetched default-branch tip (workers branch per contract) · non-zero exit
# aborts the dispatch.
set -euo pipefail

input=$(cat)
# Field name varies across harness builds — try known spellings, else fall
# back to a generated name and log the payload for diagnosis. A dispatch must
# not die on schema drift.
requested=$(node -e '
let d="";
process.stdin.on("data",c=>d+=c).on("end",()=>{
	let j;
	try { j = JSON.parse(d) } catch(e) { process.stderr.write("worktree-create: bad hook input JSON: "+e+"\n"); process.exit(1) }
	j = (j && typeof j === "object") ? j : {};
	const p = j.worktree_path || j.worktreePath || j.path || j.worktree_name || j.worktreeName || j.name || "";
	process.stdout.write(String(p));
})' <<<"$input")

if [ -n "$requested" ]; then
	name=$(basename "$requested")
else
	name="agent-$(date +%s)-$$"
	log_dir="$HOME/.config/agent-tools/var"
	mkdir -p "$log_dir"
	printf '%s\n' "$input" > "$log_dir/worktree-create-last-input.json"
	echo "worktree-create: no path/name field in hook input — using generated name $name (payload logged to $log_dir/worktree-create-last-input.json)" >&2
fi

common=$(git rev-parse --git-common-dir)
primary=$(cd "$(dirname "$common")" && pwd) # primary checkout, even when run from inside a worktree
target_root="$(dirname "$primary")/$(basename "$primary")-worktrees"
mkdir -p "$target_root"
wt="$target_root/$name"

# Base on the FETCHED default-branch tip, never the invoking checkout's HEAD —
# the primary tree is fetch-only under agent conventions and may sit stale (or
# on another branch entirely).
base=$(git -C "$primary" symbolic-ref -q --short refs/remotes/origin/HEAD || true)
if [ -z "$base" ] && git -C "$primary" show-ref -q refs/remotes/origin/main; then
	base=origin/main
fi
git worktree add --detach "$wt" ${base:+"$base"} >&2
echo "$wt"
