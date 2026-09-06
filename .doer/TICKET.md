# A mark on a finding records neither who set it nor when

GitHub issue: sorokinvj/check-my-app#10

When someone marks a finding — *watch*, *that's fine*, *fixed*, *dispute* — the mark is stored and nothing else. Not who set it, not when.

That gap produced a wrong statement to a customer: a daily email opened with *"On your flagged analytics concern"* about something the owner had never touched, because a six-week-old mark existed and we assumed it was his. We could not tell whether he set it or one of our own automated sessions did while walking a verdict page. Both have happened before.

**Why it matters.** Anything we say about what the customer asked for has to be something we can show. Without an author and a date on a mark, the product is guessing about its own user and telling them what they wanted.

**How to know it is gone.** For any mark, it can be said who set it and when — and text shown to a customer only attributes a mark when that record says it was theirs.

Source ticket: CHE-109 · https://linear.app/joblander/issue/CHE-109

---
*Filed for the doer (CLAUDE.md §9).*
