/**
 * Capability Artifact schema — the focal point of the system.
 *
 * A capability is what the LLM *discovers once* and what an AI agent *invokes many
 * times* in production via deterministic replay. It is deliberately decoupled from the
 * raw model transcript: nothing here references the conversation, tokens, or prompts.
 *
 * Design goals:
 *  - Typed contract (inputs/outputs) so a calling agent knows what to supply and receive.
 *  - Robust targeting: every element is described by an ordered *fallback chain* of
 *    locator strategies, not a single brittle selector, with the recorder's reasoning.
 *  - Explicit error taxonomy: expected business outcomes vs recoverable conditions vs
 *    hard failures are first-class, evaluated deterministically at replay time.
 *  - Safety metadata per step (safe vs risky/irreversible).
 *  - Versioned + reviewable by both a human and a calling agent.
 *  - Surface-agnostic: the schema describes *what* was done, not *how a browser does it*,
 *    so the same artifact shape extends to legacy web / desktop surfaces.
 *
 * We validate with Zod so a hand-edited or agent-emitted artifact is checked before it
 * is ever trusted by the replay engine.
 */
import { z } from "zod";

/** Bump when the *format* changes in a breaking way (distinct from a capability's own version). */
export const ARTIFACT_SCHEMA_VERSION = "1.0.0" as const;

// ---------------------------------------------------------------------------
// Parameters & values
// ---------------------------------------------------------------------------

/** A JSON-ish type tag for typed inputs/outputs. Kept small on purpose. */
export const ParamType = z.enum(["string", "number", "boolean", "date", "money", "enum"]);
export type ParamType = z.infer<typeof ParamType>;

export const InputParam = z.object({
  name: z.string(),
  type: ParamType,
  required: z.boolean().default(true),
  description: z.string(),
  /** Allowed values when type === "enum". */
  enumValues: z.array(z.string()).optional(),
  /**
   * If true, this value is regulated/sensitive (credential, token, full PII). It is
   * accepted at invocation time but MUST NOT be persisted into artifacts, logs, or
   * evidence — redacted everywhere. See safety/redaction.ts.
   */
  sensitive: z.boolean().default(false),
  /** A non-sensitive example used only in docs/catalog, never a real value. */
  example: z.string().optional(),
});
export type InputParam = z.infer<typeof InputParam>;

export const OutputField = z.object({
  name: z.string(),
  type: ParamType,
  description: z.string(),
  /** Which step captured this output (by step id). */
  capturedByStep: z.string(),
  sensitive: z.boolean().default(false),
});
export type OutputField = z.infer<typeof OutputField>;

/**
 * A value used by a step: either a literal, or a reference to an input parameter.
 * Parameter binding is what makes a recording reusable ("look up member {memberId}").
 */
export const ValueRef = z.union([
  z.object({ kind: z.literal("literal"), value: z.string() }),
  z.object({ kind: z.literal("param"), param: z.string() }),
]);
export type ValueRef = z.infer<typeof ValueRef>;

// ---------------------------------------------------------------------------
// Locators — robust, surface-agnostic element targeting
// ---------------------------------------------------------------------------

/**
 * A single way to find a control. Ordered from most robust (accessibility role+name,
 * which survives markup churn and is available on desktop a11y trees too) to least
 * robust (raw CSS / positional nth). The replay engine tries them in order and uses the
 * first that resolves to exactly one element.
 *
 * The kinds map cleanly onto Playwright web locators today and onto an OS accessibility
 * API tomorrow (role/name/label are a11y-native; css/testid are web-only fallbacks).
 */
export const LocatorStrategy = z.discriminatedUnion("kind", [
  // Accessibility-first (portable across web + desktop):
  z.object({ kind: z.literal("role"), role: z.string(), name: z.string().optional(), exact: z.boolean().default(false) }),
  z.object({ kind: z.literal("label"), value: z.string(), exact: z.boolean().default(false) }),
  z.object({ kind: z.literal("placeholder"), value: z.string() }),
  z.object({ kind: z.literal("text"), value: z.string(), exact: z.boolean().default(false) }),
  z.object({ kind: z.literal("altText"), value: z.string() }),
  // Web-specific fallbacks (least portable; used only when a11y is insufficient):
  z.object({ kind: z.literal("testid"), value: z.string() }),
  z.object({ kind: z.literal("css"), value: z.string() }),
  // Positional last resort, scoped within a parent for legacy table/frameset layouts:
  z.object({ kind: z.literal("nth"), within: z.string(), index: z.number().int() }),
]);
export type LocatorStrategy = z.infer<typeof LocatorStrategy>;

export const Locator = z.object({
  /** Human/agent-readable description of the control ("Member ID search field"). */
  description: z.string(),
  /** Ordered fallback chain; replay tries [0], then [1], ... */
  strategies: z.array(LocatorStrategy).min(1),
  /** Recorder's reasoning about *why* this chain is robust — reviewable, not executable. */
  robustnessNote: z.string().optional(),
  /** Optional iframe/frameset path for legacy surfaces (list of frame names/urls). */
  framePath: z.array(z.string()).optional(),
});
export type Locator = z.infer<typeof Locator>;

// ---------------------------------------------------------------------------
// Checkpoints — assert we actually reached the expected state
// ---------------------------------------------------------------------------

export const Checkpoint = z.discriminatedUnion("type", [
  z.object({ type: z.literal("urlMatches"), pattern: z.string() }),
  z.object({ type: z.literal("textPresent"), text: z.string(), within: Locator.optional() }),
  z.object({ type: z.literal("textAbsent"), text: z.string() }),
  z.object({ type: z.literal("elementVisible"), locator: Locator }),
  z.object({ type: z.literal("elementCount"), locator: Locator, count: z.number().int() }),
]);
export type Checkpoint = z.infer<typeof Checkpoint>;

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Safety class of a step. "safe" actions are reversible/read-only (navigate, read, type
 * into a field, search). "risky" actions are irreversible or state-changing (submit a
 * transaction, confirm an account creation). Risky steps are handled conservatively by
 * policy (block / require confirmation / flag) — see safety/policy.ts.
 */
export const RiskClass = z.enum(["safe", "risky"]);
export type RiskClass = z.infer<typeof RiskClass>;

export const ActionType = z.enum([
  "navigate", // go to a URL (may be parameterized)
  "click", // click a control
  "type", // type a value (literal or param) into a field
  "select", // choose an option in a dropdown
  "read", // capture a declared output from the page
  "waitFor", // wait for a checkpoint/condition (no side effect)
  "assert", // assert a checkpoint (fails hard if not met)
]);
export type ActionType = z.infer<typeof ActionType>;

export const Step = z.object({
  id: z.string(), // stable id, referenced by outputs/checkpoints
  index: z.number().int(), // ordinal position
  action: ActionType,
  description: z.string(), // what/why, reviewable
  risk: RiskClass.default("safe"),

  /** Target control for click/type/select/read (omitted for navigate). */
  target: Locator.optional(),
  /** Value for navigate(url)/type/select. */
  value: ValueRef.optional(),

  /** Wait applied before considering the step done (defaults are sensible per action). */
  wait: z
    .object({
      until: z.enum(["load", "networkidle", "selectorVisible", "textPresent", "timeout"]).default("load"),
      selector: Locator.optional(),
      text: z.string().optional(),
      timeoutMs: z.number().int().default(10_000),
    })
    .optional(),

  /** Post-condition proving the step landed where expected. */
  checkpoint: Checkpoint.optional(),

  /** For read steps: declare the output captured here (name must match an OutputField). */
  capture: z
    .object({
      output: z.string(),
      from: z.enum(["text", "value", "attr"]),
      attr: z.string().optional(),
      /** Optional normalization (e.g. strip "$", commas for money). */
      normalize: z.enum(["none", "money", "trim", "digits"]).default("none"),
    })
    .optional(),
});
export type Step = z.infer<typeof Step>;

// ---------------------------------------------------------------------------
// Runtime condition rules — the error taxonomy, evaluated deterministically
// ---------------------------------------------------------------------------

/**
 * How to classify a detected runtime condition during replay:
 *  - business_outcome: a legitimate result the *caller* needs to know about
 *    (e.g. "no such member"). NOT a crash. Replay returns status=business_outcome.
 *  - recoverable: something the replay can handle itself and continue
 *    (dismiss a known interstitial, wait/retry a transient load).
 *  - hard_failure: stop and surface a clear, debuggable error.
 */
export const ConditionClass = z.enum(["business_outcome", "recoverable", "hard_failure"]);
export type ConditionClass = z.infer<typeof ConditionClass>;

export const RecoveryAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("dismissDialog") }),
  z.object({ kind: z.literal("click"), target: Locator }),
  z.object({ kind: z.literal("waitRetry"), timeoutMs: z.number().int().default(3000), maxAttempts: z.number().int().default(2) }),
]);
export type RecoveryAction = z.infer<typeof RecoveryAction>;

export const RuntimeRule = z.object({
  name: z.string(),
  description: z.string(),
  /** Condition that indicates this rule fired (detected on the live page). */
  when: Checkpoint,
  classify: ConditionClass,
  /** For business_outcome: the stable code returned to the caller. */
  outcomeCode: z.string().optional(),
  /** For recoverable: what to do, then re-evaluate. */
  recovery: RecoveryAction.optional(),
  message: z.string(),
});
export type RuntimeRule = z.infer<typeof RuntimeRule>;

// ---------------------------------------------------------------------------
// Surface / app / tenant identity (for reuse & heterogeneity)
// ---------------------------------------------------------------------------

export const SurfaceType = z.enum(["web", "legacy-web", "desktop"]);
export type SurfaceType = z.infer<typeof SurfaceType>;

export const AppIdentity = z.object({
  vendor: z.string(), // vendor product family, shared across tenants
  product: z.string(),
  appVersion: z.string().optional(),
  surface: SurfaceType,
});
export type AppIdentity = z.infer<typeof AppIdentity>;

/**
 * Multi-tenant reuse: an artifact recorded against the "base" vendor product can be
 * applied to many tenants. A tenant that differs only in branding/config can carry a
 * thin *override* (base ref + a small patch), rather than a full re-recording.
 */
export const TenantBinding = z.object({
  mode: z.enum(["base", "tenant-override"]).default("base"),
  tenantId: z.string().optional(), // set for tenant-override
  basedOn: z.string().optional(), // capability id@version this override specializes
});
export type TenantBinding = z.infer<typeof TenantBinding>;

// ---------------------------------------------------------------------------
// The Capability Artifact
// ---------------------------------------------------------------------------

export const ApprovalState = z.enum(["draft", "approved"]);
export type ApprovalState = z.infer<typeof ApprovalState>;

export const CapabilityArtifact = z.object({
  schemaVersion: z.literal(ARTIFACT_SCHEMA_VERSION),

  /** Stable capability identifier, e.g. "member.read_savings_balance". */
  id: z.string(),
  /** Semver of *this recording*. New discovery of the same id bumps this. */
  version: z.string(),
  name: z.string(),
  description: z.string(),

  app: AppIdentity,
  tenant: TenantBinding,

  /** Entry point; may reference the {baseUrl} param so it's tenant-portable. */
  entry: z.object({ urlTemplate: z.string() }),

  inputs: z.array(InputParam),
  outputs: z.array(OutputField),

  steps: z.array(Step).min(1),

  /** Overall success condition asserted at the end of a run. */
  successCondition: Checkpoint,

  /** Runtime conditions evaluated during replay (the error taxonomy). */
  runtimeRules: z.array(RuntimeRule).default([]),

  metadata: z.object({
    recordedAt: z.string(), // ISO
    recordedBy: z.enum(["llm-discovery", "human", "hand-authored"]),
    model: z.string().optional(),
    goal: z.string(), // the natural-language goal that produced this
    approval: ApprovalState.default("draft"),
    /** Optional stability signal from multi-run replay (stretch). */
    stability: z
      .object({ runs: z.number().int(), passed: z.number().int(), updatedAt: z.string() })
      .optional(),
    notes: z.string().optional(),
  }),
});
export type CapabilityArtifact = z.infer<typeof CapabilityArtifact>;

/** Parse + validate an unknown blob into a typed artifact (throws on invalid). */
export function parseArtifact(input: unknown): CapabilityArtifact {
  return CapabilityArtifact.parse(input);
}
