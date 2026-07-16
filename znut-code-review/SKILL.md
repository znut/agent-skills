---
name: znut-code-review
description: >
  DEPRECATED alias — this skill was renamed to `review-gate`. Load the
  `review-gate` skill instead; this stub exists only so older conventions,
  prompts, and dispatches that still name znut-code-review keep working
  during the transition. Trigger: "/znut-code-review" (legacy).
---

# znut-code-review → renamed to review-gate

This skill is now **`review-gate`**. Invoke `Skill(review-gate)` and follow it — all steps (checklist loading, mechanical pass, judgment delegation, BLOCK/PASS verdict, sha-pinned marker protocol) live there, unchanged in contract.

Transition notes: the `gh pr create` hook accepts markers in both `.review-gate/` and the legacy `.zcr-reviewed/` dir; both `scripts/review-mark.sh` and legacy `scripts/zcr-mark.sh` work; `ZCR_SKIP=1` still works as an alias of `REVIEW_GATE_SKIP=1`. This stub is deleted once no in-flight prompts reference the old name.
