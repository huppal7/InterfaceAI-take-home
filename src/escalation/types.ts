/**
 * Human-in-the-loop escalation & handoff — types and control-transfer model.
 *
 * The seam: automation must be able to PAUSE, CEDE control of the *same live session*,
 * and RESUME — and there must be an explicit record of who is (or should be) in control.
 */

export type Controller = "agent" | "human";
export type InterventionReason = "stuck" | "risky_confirmation" | "unrecoverable";

export interface InterventionRequest {
  id: string;
  runId: string;
  capabilityId: string;
  goal: string;
  reason: InterventionReason;
  stepId?: string;
  stepIndex?: number;
  currentUrl: string;
  /** Redacted, human-readable snapshot of the page state. */
  observationText: string;
  /** Path to a screenshot captured at the moment of escalation. */
  screenshot?: string;
  message: string;
  createdAt: string;
}

export type Decision = "approve" | "deny" | "resume" | "abort";

export interface InterventionDecision {
  decision: Decision;
  /** Free-text note the operator leaves (e.g. what they did). */
  note?: string;
  /** Structured record of manual actions the human performed on the live session. */
  humanActions?: { at: string; description: string }[];
  byOperator?: string;
  at: string;
}

/** A broker routes an intervention request to a human and returns their decision. */
export interface EscalationBroker {
  raise(req: InterventionRequest): Promise<InterventionDecision>;
}
