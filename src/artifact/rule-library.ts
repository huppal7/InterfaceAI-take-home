/**
 * Runtime-condition rule library — the authoritative error taxonomy per vendor product.
 *
 * These rules are NOT invented by the LLM per run. In the real system, the platform ships
 * a reviewed set of runtime-condition rules for each vendor product (many tenants share a
 * product), and discovery attaches the relevant set to the artifact. This keeps the
 * taxonomy authoritative, deterministic, and reviewable while still living *in* the
 * artifact (so replay is self-contained).
 *
 * Each rule maps a detectable page condition to one of three classes:
 *   business_outcome — a legitimate result the caller must handle (not a crash)
 *   recoverable      — replay handles it and continues (dismiss/wait-retry)
 *   hard_failure     — stop and surface a clear, debuggable error
 */
import type { RuntimeRule } from "../types/artifact.js";

export function rulesForProduct(vendor: string, product: string): RuntimeRule[] {
  if (vendor === "Meridian" && product === "MemberServicing") return MERIDIAN_RULES;
  return [];
}

const MERIDIAN_RULES: RuntimeRule[] = [
  {
    name: "record_not_found",
    description: "Member ID does not resolve to a record.",
    when: { type: "textPresent", text: "No member found" },
    classify: "business_outcome",
    outcomeCode: "NO_SUCH_MEMBER",
    message: "No member exists for the supplied member ID.",
  },
  {
    name: "permission_denied",
    description: "Operator lacks rights to view/act on this record.",
    when: { type: "textPresent", text: "restricted" },
    classify: "business_outcome",
    outcomeCode: "PERMISSION_DENIED",
    message: "Access to this member record is restricted; additional authorization is required.",
  },
  {
    name: "validation_error",
    description: "A field failed server-side validation.",
    when: { type: "textPresent", text: "must be a non-negative number" },
    classify: "business_outcome",
    outcomeCode: "VALIDATION_ERROR",
    message: "Input failed validation (initial deposit must be a non-negative number).",
  },
  {
    name: "unexpected_interstitial",
    description: "An unexpected System Notice modal is blocking the flow.",
    when: {
      type: "elementVisible",
      locator: { description: "System Notice modal", strategies: [{ kind: "role", role: "dialog", name: "System Notice", exact: false }] },
    },
    classify: "recoverable",
    recovery: { kind: "dismissDialog" },
    message: "Dismissed an unexpected System Notice interstitial and continued.",
  },
  {
    name: "session_timeout",
    description: "Session expired; app redirected to sign-in.",
    when: { type: "textPresent", text: "session has timed out" },
    classify: "hard_failure",
    message: "Session expired mid-flow. Re-authentication is required before this capability can complete.",
  },
  {
    name: "app_error",
    description: "The application returned an unexpected system error.",
    when: { type: "textPresent", text: "unexpected system error" },
    classify: "hard_failure",
    message: "The application returned an unexpected system error (500). Aborting.",
  },
];
