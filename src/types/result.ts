/**
 * Replay result contract — what a calling agent receives back from a deterministic replay.
 *
 * The single most important distinction (and the most common design mistake to avoid):
 * an expected *business outcome* ("no such member") is NOT a failure. The contract keeps
 * three top-level statuses apart so the caller can branch correctly.
 */
import type { ConditionClass } from "./artifact.js";

export type ReplayStatus = "success" | "business_outcome" | "failure";

export interface StepTrace {
  stepId: string;
  index: number;
  action: string;
  description: string;
  status: "ok" | "recovered" | "failed" | "skipped";
  /** Which locator strategy (index in the fallback chain) actually resolved, if any. */
  resolvedStrategy?: number;
  startedAt: string;
  durationMs: number;
  note?: string;
  screenshot?: string; // path (captured on failure or when configured)
}

export interface ReplayResult {
  capabilityId: string;
  capabilityVersion: string;
  status: ReplayStatus;

  /** Present on success: typed outputs declared by the artifact. */
  outputs?: Record<string, string | number | boolean>;

  /** Present on business_outcome: a legitimate result the caller must handle. */
  outcome?: { code: string; message: string };

  /** Present on failure: enough to debug — which step, expected vs observed. */
  failure?: {
    stepId?: string;
    stepIndex?: number;
    category: ConditionClass | "locator_unresolved" | "checkpoint_failed" | "policy_blocked" | "escalation_unresolved";
    expected: string;
    observed: string;
    message: string;
  };

  steps: StepTrace[];

  /** Evidence bundle for this run. */
  evidence: {
    runId: string;
    logPath: string;
    dir: string;
    screenshots: string[];
  };

  startedAt: string;
  finishedAt: string;
  durationMs: number;
}
