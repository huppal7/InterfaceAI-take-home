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

```bash
npm install
npx playwright install chromium      # one-time browser download
npx tsx src/artifact/seed.ts         # write the reference capability artifacts
```

Config / keys:
- **`ANTHROPIC_API_KEY`** — required **only** for the discovery run (the one LLM step).
  Everything else (replay, error handling, escalation, safety, tests) runs **without any key
  or live service** beyond the local mock app.
- Optional: `AGENT_MODEL` (default `claude-opus-5`), `APP_PORT` (default `4599`),
  `OPERATOR_PORT` (default `4600`).

Run the mock target app (needed for discovery and replay):

```bash
npm run app          # http://localhost:4599
```

---

## Demo path

Two terminals. **Terminal A** — the target app: `npm run app`.

**Terminal B** — the end-to-end thread:

```bash
# 1) DISCOVERY (real LLM-driven run — requires ANTHROPIC_API_KEY)
export ANTHROPIC_API_KEY=sk-ant-...
npx tsx src/cli/discover.ts \
  --goal "look up member 12345 and read their current savings balance"
#   → drives the live UI, records a capability, saves artifacts/member.read_savings_balance@1.0.0.json,
#     and writes the full transcript + screenshots to evidence/discovery-*/

# 2) DETERMINISTIC REPLAY (no LLM) — success, with a typed output
npx tsx src/cli/replay.ts member.read_savings_balance --input memberId=12345
#   → status: success   outputs: {"savingsBalance":8742.19}

# 3) REPLAY hitting an exceptional state — a business outcome, NOT a crash
npx tsx src/cli/replay.ts member.read_savings_balance --input memberId=00000
#   → status: business_outcome   outcome: NO_SUCH_MEMBER

# 4) A risky/irreversible capability + human-in-the-loop confirmation
npx tsx src/cli/replay.ts member.open_sub_account \
  --input memberId=10001 --input "accountType=Holiday Savings" --input initialDeposit=250 \
  --broker auto-approve
#   → risky step s7 escalates for confirmation, operator approves, run completes
```

### Running without the LLM

`member.open_sub_account` and `member.read_savings_balance` reference artifacts are
hand-authored (structurally identical to a discovered one), so **replay, the full error
taxonomy, escalation, and safety are fully runnable offline**:

```bash
npm test        # 19 tests: unit + e2e replay (spawns its own app on :4699)
```

---

## Agent-facing capability catalog (stretch)

Saved artifacts are exposed as callable capabilities an AI agent could discover and invoke by
name with typed args:

```bash
npx tsx src/cli/catalog.ts list                          # capabilities + typed signatures
npx tsx src/cli/catalog.ts describe member.read_savings_balance   # JSON tool/function schema
npx tsx src/cli/catalog.ts invoke member.read_savings_balance --input memberId=10002
```

---

## Human-in-the-loop with the real operator console

```bash
npm run operator                                    # http://localhost:4600 (watches for interventions)
# then run a replay in HEADED mode with the file broker; when it escalates, the visible
# browser window IS the live session — drive it, then approve/resume in the operator console:
npx tsx src/cli/replay.ts member.open_sub_account \
  --input memberId=10001 --input "accountType=Emergency Fund" --input initialDeposit=100 \
  --headed --broker file
```

The automation pauses, cedes control (`controller: human`), and resumes on your decision.

---

## Error-taxonomy quick reference (all runnable)

| Scenario | Command flavour | Result |
|---|---|---|
| Happy path | `memberId=12345` | `success` + outputs |
| No such member | `memberId=00000` | `business_outcome NO_SUCH_MEMBER` |
| Permission denied | `memberId=99999` | `business_outcome PERMISSION_DENIED` |
| Server validation | `open_sub_account … initialDeposit=-50 --attended` | `business_outcome VALIDATION_ERROR` |
| Bad input (typed contract) | `open_sub_account … initialDeposit=abc` | `failure` before touching the browser |
| Risky step, no operator | `open_sub_account …` (unattended, no broker) | `failure escalation_unresolved` (refuses) |
| Recoverable interstitial | run app with `FORCE_NOTICE=1`, replay read-balance | auto-dismissed, `success` |

---

## Layout

```
src/
  mock-app/     legacy bank console (target surface) + fault injection
  surface/      SurfaceDriver seam (types) + Playwright web driver + a11y snapshot
  agent/        LLM discovery loop, tool surface, prompt
  artifact/     Zod schema types, locator synthesis, recorder, rule library, store, seed
  replay/       deterministic replay engine (the production path)
  safety/       allowlist policy + redaction
  escalation/   control-transfer model, brokers, operator console
  evidence/     structured JSONL logging + screenshots + redaction
  catalog/      agent-facing capability catalog
  cli/          discover | replay | catalog
tests/          unit + e2e replay
artifacts/      saved capability artifacts (id@version.json)
evidence/        per-run logs, screenshots, results
```

Secrets are never committed (`.env*` ignored); regulated values are redacted from artifacts,
logs, and evidence.
