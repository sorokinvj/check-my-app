# Verdict page: the actions on a finding cannot be used

GitHub issue: sorokinvj/check-my-app#3

On a verdict page showing a finding, the three actions offered on it — **Mark as fixed**, **Dispute** and **Create ticket** — cannot be used. They are present in the page but never reachable: every attempt to click one fails because the control is not visible.

**Where:** `/verdict/<runId>`, the "What we found" card, on a run with at least one finding.
**Seen on:** run #100, 27 August — https://checkmyapp.dev/verdict/cmtbmwuxp0003x00nistyw2q0

**Why it matters.** Those three actions are the only way an owner tells us we were wrong, or that they fixed something. With them unreachable, the entire accuracy loop is one-directional: we report, and they have no way to answer. The number on `/dashboard/accuracy` is built from exactly these answers.

**How to know it is gone.** On a verdict with a finding, each of the three controls can be clicked and does what it says. Nothing about the fix needs to be visible to anyone; only that.

Source ticket: CHE-88 · https://linear.app/joblander/issue/CHE-88

---
*Filed for the doer. The symptom, the evidence, and how to know it is gone — diagnosis and approach are the implementer's (CLAUDE.md §9).*
