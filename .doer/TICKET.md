# The main button is dead until the page finishes loading

GitHub issue: sorokinvj/check-my-app#7

The button that starts a check arrives disabled in the HTML and only becomes usable once the page's scripts have loaded. On a slow connection — a phone, most of all — there is a window where the one control the entire funnel passes through does not respond to a tap.

**Where:** the submit control on `/` and `/check`.

**Why it matters.** Everything else on the site exists to get someone to press this. A person who taps it, gets nothing, and taps again is the most expensive failure the product has.

**How to know it is gone.** With scripts disabled or still loading, the button is not presented as unavailable, and a tap during that window is not lost.

Source ticket: CHE-108 · https://linear.app/joblander/issue/CHE-108

---
*Filed for the doer (CLAUDE.md §9).*
