# Evidence

Each run writes a directory with `events.jsonl` (structured, redacted log of what happened
and why), `result.json` (the structured ReplayResult), and screenshots (end of run, plus
failure/escalation/business-outcome frames). Discovery runs additionally write
`artifact.json` and the per-step observation screenshots the model saw.

Regenerate the curated replay set (starts its own mock app; no LLM):

```bash
npm run capture-evidence
```

## Curated runs currently included (all offline — no LLM)

| Folder | What it shows |
|---|---|
| `replay-success-read-balance` | Happy path: `memberId=12345` → `success`, `savingsBalance: 8742.19` |
| `replay-business-outcome-no-such-member` | Missing member → `business_outcome NO_SUCH_MEMBER` (not a crash) |
| `replay-business-outcome-permission-denied` | Restricted record → `business_outcome PERMISSION_DENIED` |
| `replay-validation-error` | Negative deposit that passed the typed contract → `business_outcome VALIDATION_ERROR` |
| `replay-risky-approved` | Irreversible step escalates; auto-operator approves; confirmation number returned |
| `replay-recoverable-interstitial` | System Notice modal auto-dismissed (`recovered`), run still `success` |

Inspect a run's decision trail:

```bash
# bash
grep -E 'risky|escalation|control|business_outcome|runtime_rule' evidence/replay-risky-approved/events.jsonl

# PowerShell
Select-String -Path evidence/replay-risky-approved/events.jsonl -Pattern 'risky|escalation|control|business_outcome|runtime_rule'
```

## Discovery run (real LLM)

`discovery-look-up-member-12345-and-read-their-curr-2026-08-18T04-46-23-802Z` — Claude
drove the live mock console to look up member `12345`, read the savings balance, and
saved `member.read_savings_balance@1.0.0` (`recordedBy: llm-discovery`). Observation
screenshots the model saw are in that folder (`002-obs-0.png` … `009-obs-3.png`).

To reproduce (requires `ANTHROPIC_API_KEY`; do not commit the key):

```bash
npm run app
npx tsx src/cli/discover.ts --goal "look up member 12345 and read their current savings balance"
```
