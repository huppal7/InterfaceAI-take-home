# Evidence

Each run writes a directory with `events.jsonl` (structured, redacted log of what happened
and why), `result.json` (the structured ReplayResult), and screenshots (start/end, plus
failure/escalation frames). Discovery runs additionally write `artifact.json` and the
per-step observation screenshots the model saw.

## Curated runs currently included (all offline — no LLM)

- `replay-member-read-savings-balance-*` — two runs: the happy path (`memberId=12345` →
  `success`, `savingsBalance: 8742.19`) and a missing member (`memberId=00000` →
  `business_outcome NO_SUCH_MEMBER`, i.e. an exceptional state reported as a legitimate
  outcome, not a crash).
- `replay-member-open-sub-account-*` — two runs: the risky/irreversible flow with operator
  confirmation (`--broker auto-approve` → `success`, a confirmation number), and a
  server-side validation rejection (`initialDeposit=-50` → `business_outcome
  VALIDATION_ERROR`).

Inspect a run's decision trail:

```bash
D=$(ls -dt evidence/replay-member-open-sub-account-* | head -1)
grep -E 'risky|escalation|control|business_outcome|runtime_rule' "$D/events.jsonl"
```

## Still to capture: the real LLM discovery run

The heart of the project (a genuine LLM-driven run against the live surface) needs an
`ANTHROPIC_API_KEY`. One command produces it and drops the transcript + artifact here:

```bash
npm run app   # terminal A
ANTHROPIC_API_KEY=sk-ant-... npx tsx src/cli/discover.ts \
  --goal "look up member 12345 and read their current savings balance"   # terminal B
```
