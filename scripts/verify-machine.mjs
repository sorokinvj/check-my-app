import { decidePr, MAX_ROUNDS } from "./doer/machine.mjs";
const base = { headSha: "aaaaaaa1", checks: [], reviewReportedForHead: false, unresolvedFindings: 0, roundsUsed: 0, mayMerge: false };
const green = [{ name: "check", conclusion: "success", headSha: "aaaaaaa1" }, { name: "deploy", conclusion: "skipped", headSha: "aaaaaaa1" }];
const cases = [
  ["нет проверок вовсе", { ...base }, "waitingForChecks"],
  ["проверка ещё идёт", { ...base, checks: [{ name: "check", conclusion: null, headSha: "aaaaaaa1" }] }, "waitingForChecks"],
  ["CI упал, раунды есть", { ...base, checks: [{ name: "check", conclusion: "failure", headSha: "aaaaaaa1" }] }, "fixing"],
  ["CI упал, раунды кончились", { ...base, roundsUsed: 3, checks: [{ name: "check", conclusion: "failure", headSha: "aaaaaaa1" }] }, "blocked"],
  ["зелено, ревью не было", { ...base, checks: green }, "waitingForReview"],
  ["ревью о старом head не считается", { ...base, checks: green, reviewReportedForHead: false }, "waitingForReview"],
  ["есть замечания, раунды есть", { ...base, checks: green, reviewReportedForHead: true, unresolvedFindings: 4 }, "fixing"],
  ["3 раунда, замечания остались", { ...base, checks: green, reviewReportedForHead: true, unresolvedFindings: 2, roundsUsed: 3 }, "blocked"],
  ["чисто, но мерж не разрешён", { ...base, checks: green, reviewReportedForHead: true }, "awaitingOwner"],
  ["чисто и разрешено", { ...base, checks: green, reviewReportedForHead: true, mayMerge: true }, "merging"],
  ["skipped не провал", { ...base, checks: [{ name: "deploy", conclusion: "skipped", headSha: "aaaaaaa1" }], reviewReportedForHead: true, mayMerge: true }, "merging"],
  ["cancelled блокирует", { ...base, checks: [{ name: "check", conclusion: "cancelled", headSha: "aaaaaaa1" }], roundsUsed: 3 }, "blocked"],
];
let bad = 0;
for (const [name, facts, want] of cases) {
  const r = decidePr(facts);
  const ok = r.state === want;
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} → ${r.state}${ok ? "" : ` (ждали ${want})`}\n        ${r.reason}`);
}
console.log(bad === 0 ? `\nвсе прошли, MAX_ROUNDS=${MAX_ROUNDS}` : `\n${bad} УПАЛО`);
process.exit(bad ? 1 : 0);
