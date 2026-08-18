# Computer-Use Automation System

Record-once / replay-many automation for **legacy back-office apps that have no API**. An
LLM **discovers** how to accomplish a goal by driving a real UI; the run becomes a typed,
versioned **capability artifact**; an AI agent then invokes it in production via
**deterministic replay** — no model in the decision loop — with a real error taxonomy,
safety guardrails, and human-in-the-loop escalation.

> The design write-up (architecture, schema, trade-offs, cuts) is in **[REPORT.md](./REPORT.md)**.

The concrete target is a purpose-built **legacy bank member-servicing console**
(`src/mock-app`): server-rendered, table-based, **no test IDs**, a frameset-style iframe,
and deterministic fault injection — a proxy for the real thing (no real bank system, no real
PII).

---

## Setup

Requires **Node.js 20+**.

```bash
npm install
npx playwright install chromium      # one-time browser download
npm run seed                         # write the reference capability artifacts
```

Config / keys:
- **`ANTHROPIC_API_KEY`** — required **only** to re-run discovery. A genuine LLM discovery
  transcript is already in `evidence/discovery-look-up-member-12345-and-read-their-curr-2026-08-18T04-46-23-802Z`.
  Replay, error handling, escalation, safety, the catalog, and tests all run **without any key**.
- Optional: `AGENT_MODEL` (default `claude-opus-5`), `APP_PORT` (default `4599`),
  `OPERATOR_PORT` (default `4600`).

Start the mock target app (needed for discovery, replay, and the catalog invoke demo):

```bash
npm run app          # http://localhost:4599
```

---

## Demo path (offline — no LLM)

Two terminals. **Terminal A:** `npm run app`.

**Terminal B:**

```bash
# 1) DETERMINISTIC REPLAY — success, with a typed output
npx tsx src/cli/replay.ts member.read_savings_balance --input memberId=12345
#   → status: success   outputs: {"savingsBalance":8742.19}

# 2) Exceptional state — a business outcome, NOT a crash
npx tsx src/cli/replay.ts member.read_savings_balance --input memberId=00000
#   → status: business_outcome   outcome: NO_SUCH_MEMBER

# 3) Risky/irreversible capability + human-in-the-loop confirmation
npx tsx src/cli/replay.ts member.open_sub_account \
  --input memberId=10001 --input "accountType=Holiday Savings" --input initialDeposit=250 \
  --broker auto-approve
#   → risky step s7 escalates for confirmation, operator approves, run completes
```

On PowerShell, drop the `\` line continuations and put the flags on one line.

`member.open_sub_account` and `member.read_savings_balance` are hand-authored reference
artifacts (structurally identical to a discovered one), so **replay, the full error
taxonomy, escalation, and safety are fully runnable offline**.

```bash
npm test        # unit + e2e replay (spawns its own app; no LLM)
```

---

## Optional: re-run genuine LLM discovery

A captured live run is already in `/evidence`. Re-running this step needs a model API key
and is isolated from everything else. Do not commit the key.

```bash
# Terminal A
npm run app

# Terminal B (bash)
export ANTHROPIC_API_KEY=sk-ant-...
npx tsx src/cli/discover.ts \
  --goal "look up member 12345 and read their current savings balance"

# Terminal B (PowerShell)
$env:ANTHROPIC_API_KEY="sk-ant-..."
npx tsx src/cli/discover.ts --goal "look up member 12345 and read their current savings balance"
```

A successful run writes `artifacts/member.read_savings_balance@1.0.0.json` and a
`evidence/discovery-*` transcript with the observations the model saw. Replay that artifact
the same way as above — discovery is not on the production path.

---

## Agent-facing capability catalog (stretch)

Saved artifacts are exposed as callable capabilities an AI agent could discover and invoke by
name with typed args:

```bash
npx tsx src/cli/catalog.ts list
npx tsx src/cli/catalog.ts describe member.read_savings_balance
npx tsx src/cli/catalog.ts invoke member.read_savings_balance --input memberId=10002
```

---

## Human-in-the-loop with the operator console

```bash
npm run operator                                    # http://localhost:4600
npx tsx src/cli/replay.ts member.open_sub_account \
  --input memberId=10001 --input "accountType=Emergency Fund" --input initialDeposit=100 \
  --headed --broker file
```

The automation pauses, cedes control (`controller: human`) of the **same headed browser
window**, and resumes on your decision.

---

## Error-taxonomy quick reference (all runnable)

| Scenario | Command flavour | Result |
|---|---|---|
| Happy path | `memberId=12345` | `success` + outputs |
| No such member | `memberId=00000` | `business_outcome NO_SUCH_MEMBER` |
| Permission denied | `memberId=99999` | `business_outcome PERMISSION_DENIED` |
| Server validation | `open_sub_account … initialDeposit=-50 --attended` | `business_outcome VALIDATION_ERROR` |
| Bad input (typed contract) | `open_sub_account … initialDeposit=abc` | `failure` before touching the browser |
| Risky step, no operator | `open_sub_account …` (unattended, no broker) | `failure escalation_unresolved` |
| Recoverable interstitial | `npm run app` with `FORCE_NOTICE=1`, then replay read-balance | auto-dismissed, `success` |

Curated logs and screenshots for these runs live in [`evidence/`](./evidence/). Regenerate
them with `npm run capture-evidence` (starts its own app; no LLM).

---

## Layout

```
src/
  mock-app/     legacy bank console (target surface) + fault injection
  surface/      SurfaceDriver seam (types) + Playwright web driver + a11y snapshot
  agent/        LLM discovery loop, tool surface, prompt
  artifact/     Zod schema, locator synthesis, recorder, rule library, store, seed
  replay/       deterministic replay engine (the production path)
  safety/       allowlist policy + redaction
  escalation/   control-transfer model, brokers, operator console
  evidence/     structured JSONL logging + screenshots + redaction
  catalog/      agent-facing capability catalog
  cli/          discover | replay | catalog | capture-evidence
tests/          unit + e2e replay
artifacts/      saved capability artifacts (id@version.json)
evidence/       per-run logs, screenshots, results
```

Secrets are never committed (`.env*` ignored); regulated values are redacted from artifacts,
logs, and evidence.
