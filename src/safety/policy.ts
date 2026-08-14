/**
 * Safety & policy guardrails.
 *
 * Two independent controls:
 *  1. An explicit, configurable ALLOWLIST — permitted origins, route patterns, and action
 *     types. The agent (discovery) and the replay engine both refuse to act outside it.
 *  2. RISK handling — steps are classified safe vs risky/irreversible in the artifact.
 *     Risky steps are handled conservatively per a configurable mode.
 *
 * This is a policy *decision* layer; enforcement is wired into the agent loop and the
 * replay engine so nothing can act outside the allowlist even if a step says to.
 */
import { z } from "zod";
import type { ActionType } from "../types/artifact.js";

export const AllowlistPolicy = z.object({
  allowedOrigins: z.array(z.string()), // e.g. ["http://localhost:4599"]
  allowedPathPatterns: z.array(z.string()), // regex strings matched against URL pathname
  allowedActions: z.array(z.string()), // ActionType values permitted
  /** How to handle risky/irreversible steps during UNATTENDED replay. */
  riskyStepMode: z.enum(["block", "confirm", "flag"]).default("confirm"),
});
export type AllowlistPolicy = z.infer<typeof AllowlistPolicy>;

export const DEFAULT_POLICY: AllowlistPolicy = {
  allowedOrigins: ["http://localhost:4599"],
  allowedPathPatterns: ["^/login$", "^/console$", "^/snapshot$", "^/members(/.*)?$", "^/logout$"],
  allowedActions: ["navigate", "click", "type", "select", "read", "waitFor", "assert"],
  riskyStepMode: "confirm",
};

/**
 * Default policy parameterized to a given target origin. In production the allowlist is
 * an explicit, reviewed config per tenant/app; here we derive the origin from the target
 * so the *shape* of enforcement is real while remaining runnable against any local port.
 */
export function policyForBaseUrl(baseUrl: string): AllowlistPolicy {
  let origin = baseUrl;
  try {
    const u = new URL(baseUrl);
    origin = `${u.protocol}//${u.host}`;
  } catch {
    /* keep as-is */
  }
  return { ...DEFAULT_POLICY, allowedOrigins: [origin] };
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

export function checkNavigation(policy: AllowlistPolicy, url: string): PolicyDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: `unparseable url: ${url}` };
  }
  const origin = `${parsed.protocol}//${parsed.host}`;
  if (!policy.allowedOrigins.includes(origin)) {
    return { allowed: false, reason: `origin not allowlisted: ${origin}` };
  }
  const pathOk = policy.allowedPathPatterns.some((p) => new RegExp(p).test(parsed.pathname));
  if (!pathOk) {
    return { allowed: false, reason: `path not allowlisted: ${parsed.pathname}` };
  }
  return { allowed: true, reason: "ok" };
}

export function checkAction(policy: AllowlistPolicy, action: ActionType): PolicyDecision {
  return policy.allowedActions.includes(action)
    ? { allowed: true, reason: "ok" }
    : { allowed: false, reason: `action type not allowlisted: ${action}` };
}

export type RiskDisposition = "proceed" | "blocked" | "needs_confirmation" | "flagged";

/**
 * Decide how to handle a risky step given the policy mode and whether a human is present.
 * - attended (discovery, or replay with an operator online): risky steps proceed but are flagged.
 * - unattended (production replay): mode governs — block, require confirmation (escalate), or flag.
 */
export function disposeRiskyStep(policy: AllowlistPolicy, attended: boolean): RiskDisposition {
  if (attended) return "flagged"; // proceed, but recorded/flagged
  switch (policy.riskyStepMode) {
    case "block":
      return "blocked";
    case "confirm":
      return "needs_confirmation";
    case "flag":
      return "flagged";
  }
}
