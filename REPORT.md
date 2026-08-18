# Design write-up — Computer-Use Automation System

A record-once / replay-many system for driving legacy back-office apps that have no API.
The model **discovers** a flow once; the run becomes a typed, versioned **capability
artifact**; an AI agent then invokes it in production via **deterministic replay** — no
model in the decision loop.

**Language/stack:** TypeScript + Playwright + the Anthropic SDK + Zod. TypeScript because
the artifact schema is the centrepiece and static + runtime (Zod) typing pays off across
recorder, replay, and the agent-facing catalog. Target surface: a purpose-built **legacy
bank console** (`src/mock-app`) — server-rendered, table-based, **no test IDs**, a
frameset-style iframe, and deterministic fault injection — because a proxy target I control
is the only way to exercise the *interesting* problems (the full runtime error taxonomy) on
demand.

---

## 1. Architecture

Two paths over one shared spine:

```
DISCOVERY (real LLM, once)                REPLAY (deterministic, many)
  goal + target                             artifact + typed inputs
    │                                            │
    ▼                                            ▼
  Agent loop  ──observe→decide→act──►  SurfaceDriver  ◄──execute steps── Replay engine
  (Claude, tools)      │              (perceive / act)         │
    │  records                          Playwright(web)        │ runtime-rule eval
    ▼                                    │  (a11y-first)        ▼
  Recorder ─► Capability Artifact (Zod) ─► Store ─► Catalog ─► ReplayResult
                                                                │
                             Safety (allowlist + redaction) ────┤
                             Escalation (control transfer) ─────┤
                             Evidence (JSONL + screenshots) ────┘
```

**Key boundary — the `SurfaceDriver` seam** (`src/surface/types.ts`). Perception yields an
*accessibility-first* observation (role/name/text + screenshot); actions resolve a durable
`Locator` fallback chain. Nothing above this interface knows about Playwright. This is the
seam that lets discovery, replay, desktop, and legacy-web share one recorded-flow
representation.

**Decisions & trade-offs.**
- **Accessibility-tree-first, not DOM selectors or pure screenshot+coords.** The a11y view
  (roles, names, labels) is what survives markup churn *and* is native to OS a11y trees, so
  the same locator kinds carry to desktop. Screenshots ride along for the model's grounding
  but aren't the primary target. This directly answers "bias toward an approach that works
  with no clean DOM."
- **The agent acts by ephemeral `ref`, the recorder synthesizes durable locators.** During
  perception each control gets a throwaway `data-cu-ref`; the recorder converts the
  acted-upon element into an ordered fallback chain and **never persists the ref**. So the
  artifact never depends on perception-time instrumentation (the app itself has no test IDs).
- **Single process, synchronous.** No queues/services — the brief explicitly discourages
  premature scaling infra. The abstractions (driver seam, artifact schema, catalog) are
  where scale-readiness lives.
- **Two brokers for escalation** so the handoff mechanism is real *and* testable offline
  (see §5).

---

## 2. Artifact schema

`src/types/artifact.ts` (Zod → inferred TS). An artifact is a **capability contract**, not a
step list. It is decoupled from the model transcript — nothing references prompts or tokens.

Top level: `id`, semver `version`, `app` identity (vendor/product/surface), `tenant`
binding, `entry` URL template, typed `inputs`, typed `outputs`, ordered `steps`, an overall
`successCondition`, a set of `runtimeRules` (the error taxonomy, §3), and `metadata`
(recordedBy, model, goal, approval state).

The shape decisions that matter:

- **Typed inputs/outputs** (`InputParam` / `OutputField`) — a calling agent knows exactly
  what to supply and receive. `sensitive` marks regulated fields for redaction. Values are
  bound by reference (`{kind:"param"}`), so a recording is reusable ("look up member
  `{memberId}`") and secrets never enter the artifact by construction.
- **Locators are fallback chains with reasoning**, not single selectors. `LocatorStrategy`
  is ordered most-robust-first: `role`+name → `label` → `placeholder` → `text` → `css#id`.
  Each carries a `robustnessNote` a human reviewer can read. `framePath` supports legacy
  framesets. Readable values (a balance) are targeted by stable id, *not* by their value
  (which varies per run) — see `synthesizeReadLocator`.
- **Checkpoints are first-class** (`Checkpoint` union) — per-step and overall — so replay
  asserts it actually reached the expected state instead of assuming a click worked.
- **`runtimeRules` embed the error taxonomy in the artifact** — self-contained, reviewable,
  and authoritative (see §3).
- **Versioned + reviewable.** Stored as `id@version.json`, diff-friendly, with an
  `approval` state (`draft`→`approved`) that gates unattended replay.

Everything is `parseArtifact()`-validated before it is ever trusted, whether it came from
discovery or was hand-edited.

---

## 3. Determinism & error handling

**Determinism.** Replay (`src/replay/engine.ts`) runs with **no LLM**. It validates inputs
against the typed contract, then for each step resolves the locator by trying the fallback
chain in order and using the first that resolves (the trace records *which* strategy hit —
in practice strategy #0, the accessibility target). Explicit waits and checkpoints replace
guesswork. Same inputs → same steps → same outputs.

**The error taxonomy is the load-bearing part.** After each step the engine evaluates the
artifact's `runtimeRules` against the live page and classifies into exactly three buckets —
the distinction the brief calls the most common design mistake:

| Class | Meaning | Result contract |
|---|---|---|
| `business_outcome` | a legitimate result the caller needs (not a crash) | `status:"business_outcome"`, `{code,message}` |
| `recoverable` | replay handles it and continues (dismiss/wait-retry) | logged `recovered`, run proceeds |
| `hard_failure` | stop and surface a debuggable error | `status:"failure"`, `{step,expected,observed,category}` |

Concrete, all demonstrated (`tests/replay.e2e.test.ts`, `/evidence`):
`NO_SUCH_MEMBER`, `PERMISSION_DENIED`, `VALIDATION_ERROR` → business outcomes;
unexpected interstitial modal → recoverable (auto-dismissed, run completes);
session-timeout / app-500 → hard failures.

Two extra layers: the **typed input contract** rejects malformed values *before touching the
browser* (a non-numeric deposit never reaches the server), while a value that passes the
contract but violates a server business rule (a negative deposit) surfaces as a
`VALIDATION_ERROR` *business outcome*. And `ReplayResult` is fully structured — success with
outputs, a known outcome, or a failure naming the step, expectation, and observation, with a
screenshot.

**Rules come from a reviewed library, not the LLM.** `rulesForProduct(vendor, product)`
ships the taxonomy per vendor product (which many tenants share) and attaches it at record
time — authoritative and deterministic, while still living *in* the artifact so replay is
self-contained. UI drift is the secondary concern (stable enterprise UIs); the fallback
chain absorbs minor drift, and a drifted primary that still resolves via a fallback is a
signal to re-record.

---

## 4. Heterogeneity & multi-tenant

**Surface abstraction.** The `recorded flow` (artifact) is expressed in surface-agnostic
terms: roles, names, labels, text, checkpoints. The `SurfaceDriver` is the only thing that
knows *how* to perceive/act. Extending to a **legacy web app** is the same `WebDriver` with
`framePath` locators (already modelled) and heavier reliance on text/label strategies when
roles are absent. Extending to a **desktop app** is a new `DesktopDriver` backed by an OS
accessibility API implementing the same interface — `role`/`label`/`text` locator kinds map
directly to a11y trees; only `css`/`testid` (web-only) would drop out of synthesis. Because
the seam is `perceive/act`, the recorded flow and replay engine are unchanged.

**Multi-tenant reuse.** `AppIdentity` (vendor/product/surface) is the reuse key: hundreds of
tenants running the same vendor product share one *base* artifact rather than re-recording
per tenant. `TenantBinding` supports a thin `tenant-override` (`basedOn` a base
`id@version` + a small patch) for tenants that differ only in branding/config, instead of a
full re-recording. The `entry.urlTemplate` uses `{baseUrl}` so a base artifact is portable
across tenant hostnames. Drift management: version artifacts, run them across tenants, and
use the replay `stability` signal (schema field present) to flag a tenant/version where a
base capability starts failing — that tenant gets a targeted override, the rest keep the
base. (Override *application* and canonicalization are designed, not built — see §7.)

---

## 5. Escalation & handoff

**Detect.** Replay raises an intervention when it is (a) stuck — a locator won't resolve
even via fallbacks, or (b) about to take a risky/irreversible step that policy says needs
confirmation. Discovery raises one when the agent calls `escalate`.

**Route with context.** `InterventionRequest` carries capability/goal, current step, current
URL, a redacted state snapshot, a screenshot, and *why* it stopped.

**Control transfer is explicit and real.** `SessionController` holds an enforced
`controller` field (`agent`|`human`). On escalation the engine **cedes control**, and while
a human holds it the automation is guarded from acting (`assertAgentControls`). The human
operates the **same live session** — the automation runs a headed browser and *that window
is the session the operator drives* — not a fresh one. On **resume** the engine reclaims
control and continues; the human's actions are recorded into the decision/evidence.

**Two brokers, one mechanism.** `FileBroker` writes the request to disk and polls for a
decision file; the mock **operator console** (`src/escalation/operator-server.ts`) renders
pending interventions with context + screenshot and records approve/deny/resume/abort. The
`AutoBroker` is a deliberately-mocked operator (used in tests/offline demos) that runs the
same control-transfer path and can perform a scripted manual action. The co-browsing UI is
mocked; the **handoff mechanism and control-transfer model are real**.

---

## 6. Safety

Two independent controls, enforced in the loop, not just advised:

- **Allowlist** (`src/safety/policy.ts`): permitted origins, route patterns, and action
  types. Every navigation and action is checked; a click that would leave the allowlisted
  surface is blocked. The default is parameterized to the target origin so enforcement is
  real and still runnable anywhere.
- **Risk handling**: steps are classified `safe` vs `risky` (irreversible/state-changing) in
  the artifact. Unattended replay disposes risky steps by policy mode — **block**, **confirm**
  (escalate for approval), or **flag**. Default is `confirm`: an irreversible step with no
  operator online **refuses** rather than proceeding (proven in tests).
- **Redaction** (`src/safety/redaction.ts`): sensitive input values and secret-like patterns
  (credentials, tokens, SSN/account-number shapes) are scrubbed from every artifact, log,
  and evidence file. Defense in depth: steps store *parameter references*, so sensitive
  values never enter the artifact even before scrubbing.

**Limits (honest).** The allowlist is route/origin-level, not semantic (it can't tell a
"read" GET from a mutating one beyond the risk flag). Redaction patterns are heuristic.
Risk classification during discovery uses the model's `risky` flag plus a verb heuristic —
good, not infallible; approval gating is the backstop.

---

## 7. Cuts

Deliberately stubbed at clean seams (all documented, none load-bearing):

- **Desktop / legacy-frameset drivers** — designed (§4), one surface built. The seam is real.
- **Real co-browsing operator console** — mocked UI; real handoff mechanism (§5).
- **Multi-tenant override *application* + canonicalization** (`/item/123`→`/item/:id`) —
  schema supports it (`TenantBinding`, `{baseUrl}` templating); the resolver isn't built.
- **Per-step checkpoint synthesis in discovery** — discovered artifacts get the entry
  checkpoint + success condition + URL checkpoints on navigation; the richer per-step
  checkpoints in the hand-authored reference artifacts would be auto-synthesized with more
  time.
- **Assisted single-step LLM fallback on replay failure** — the escalation path covers the
  human case; a bounded, policy-checked LLM recovery is a natural next stretch.

**What I'd build next:** (1) the tenant-override resolver + canonicalization so one base
artifact drives many tenants; (2) multi-run stability scoring feeding the `approval` gate;
(3) a `DesktopDriver` to prove the seam on a non-web surface.
