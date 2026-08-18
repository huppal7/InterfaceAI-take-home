/**
 * End-to-end replay tests against the live mock app (no LLM). Exercises the core loop and
 * the full error taxonomy: success, business outcomes, recoverable, hard failure, and escalation.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadArtifact } from "../src/artifact/store.js";
import { replay, type ReplayOptions } from "../src/replay/engine.js";
import { AutoBroker } from "../src/escalation/broker.js";
import { launchMockApp } from "../src/mock-app/launch.js";
import type { CapabilityArtifact, Step } from "../src/types/artifact.js";

const PORT = 4699;
const BASE = `http://localhost:${PORT}`;
const EVIDENCE = join("evidence", "_test");
let app: ChildProcess;

function replayOpts(extra: Partial<ReplayOptions> = {}): ReplayOptions {
  return { baseUrl: BASE, headless: true, evidenceRoot: EVIDENCE, ...extra };
}

function withNavigateUrl(artifact: CapabilityArtifact, urlTemplate: string): CapabilityArtifact {
  return {
    ...artifact,
    steps: artifact.steps.map((s) =>
      s.action === "navigate" ? { ...s, value: { kind: "literal" as const, value: urlTemplate } } : s
    ),
  };
}

function withBrokenLocator(artifact: CapabilityArtifact, stepId: string): CapabilityArtifact {
  return {
    ...artifact,
    steps: artifact.steps.map((s: Step) =>
      s.id === stepId
        ? { ...s, target: { description: "intentionally missing", strategies: [{ kind: "css" as const, value: "#does-not-exist" }] } }
        : s
    ),
  };
}

beforeAll(async () => {
  app = await launchMockApp(PORT);
});

afterAll(() => {
  app?.kill();
});

describe("deterministic replay — core loop", () => {
  it("reads a member savings balance (success + typed output)", async () => {
    const a = loadArtifact("member.read_savings_balance");
    const r = await replay(a, { memberId: "12345" }, replayOpts());
    expect(r.status).toBe("success");
    expect(r.outputs?.savingsBalance).toBe(8742.19);
    expect(r.steps.find((s) => s.stepId === "s2")?.resolvedStrategy).toBe(0);
  });

  it("opens a sub-account through the risky step with operator approval", async () => {
    const a = loadArtifact("member.open_sub_account");
    const r = await replay(
      a,
      { memberId: "10001", accountType: "Holiday Savings", initialDeposit: "150" },
      replayOpts({ broker: new AutoBroker({ decision: "approve" }) })
    );
    expect(r.status).toBe("success");
    expect(String(r.outputs?.confirmationNumber)).toMatch(/^SA-10001-/);
  });
});

describe("error taxonomy — business outcomes are NOT failures", () => {
  it("returns NO_SUCH_MEMBER as a business outcome for a missing member", async () => {
    const a = loadArtifact("member.read_savings_balance");
    const r = await replay(a, { memberId: "00000" }, replayOpts());
    expect(r.status).toBe("business_outcome");
    expect(r.outcome?.code).toBe("NO_SUCH_MEMBER");
  });

  it("returns PERMISSION_DENIED as a business outcome for a restricted member", async () => {
    const a = loadArtifact("member.read_savings_balance");
    const r = await replay(a, { memberId: "99999" }, replayOpts());
    expect(r.status).toBe("business_outcome");
    expect(r.outcome?.code).toBe("PERMISSION_DENIED");
  });

  it("returns VALIDATION_ERROR when the server rejects a value that passed the input contract", async () => {
    const a = loadArtifact("member.open_sub_account");
    const r = await replay(
      a,
      { memberId: "10001", accountType: "Emergency Fund", initialDeposit: "-5" },
      replayOpts({ attended: true })
    );
    expect(r.status).toBe("business_outcome");
    expect(r.outcome?.code).toBe("VALIDATION_ERROR");
  });
});

describe("recoverable and hard-failure runtime conditions", () => {
  it("dismisses an unexpected interstitial and still succeeds", async () => {
    const a = withNavigateUrl(loadArtifact("member.read_savings_balance"), "{baseUrl}/console?notice=1");
    const r = await replay(a, { memberId: "12345" }, replayOpts());
    expect(r.status).toBe("success");
    expect(r.outputs?.savingsBalance).toBe(8742.19);
    expect(r.steps.some((s) => s.status === "recovered")).toBe(true);
  });

  it("classifies a session timeout as a hard failure", async () => {
    const a = withNavigateUrl(loadArtifact("member.read_savings_balance"), "{baseUrl}/console?fault=timeout");
    const r = await replay(a, { memberId: "12345" }, replayOpts());
    expect(r.status).toBe("failure");
    expect(r.failure?.category).toBe("hard_failure");
    expect(r.failure?.observed).toBe("session_timeout");
  });

  it("classifies an application 500 as a hard failure", async () => {
    const a = withNavigateUrl(loadArtifact("member.read_savings_balance"), "{baseUrl}/console?fault=error");
    const r = await replay(a, { memberId: "12345" }, replayOpts());
    expect(r.status).toBe("failure");
    expect(r.failure?.category).toBe("hard_failure");
    expect(r.failure?.observed).toBe("app_error");
  });
});

describe("safety & escalation", () => {
  it("rejects a non-numeric money input at the contract boundary (hard failure, before acting)", async () => {
    const a = loadArtifact("member.open_sub_account");
    const r = await replay(
      a,
      { memberId: "10001", accountType: "Holiday Savings", initialDeposit: "abc" },
      replayOpts({ attended: true })
    );
    expect(r.status).toBe("failure");
    expect(r.failure?.category).toBe("hard_failure");
    expect(r.steps.length).toBe(0);
  });

  it("refuses an irreversible step unattended with no operator (escalation unresolved)", async () => {
    const a = loadArtifact("member.open_sub_account");
    const r = await replay(
      a,
      { memberId: "10001", accountType: "Holiday Savings", initialDeposit: "100" },
      replayOpts()
    );
    expect(r.status).toBe("failure");
    expect(r.failure?.category).toBe("escalation_unresolved");
  });

  it("refuses a risky step when the operator denies confirmation", async () => {
    const a = loadArtifact("member.open_sub_account");
    const r = await replay(
      a,
      { memberId: "10001", accountType: "Holiday Savings", initialDeposit: "100" },
      replayOpts({ broker: new AutoBroker({ decision: "deny" }) })
    );
    expect(r.status).toBe("failure");
    expect(r.failure?.category).toBe("escalation_unresolved");
  });

  it("gates unattended replay on approval state", async () => {
    const a = loadArtifact("member.read_savings_balance");
    const draft = { ...a, metadata: { ...a.metadata, approval: "draft" as const } };
    const r = await replay(draft, { memberId: "12345" }, replayOpts({ requireApproval: true }));
    expect(r.status).toBe("failure");
    expect(r.failure?.category).toBe("policy_blocked");
  });

  it("escalates when a locator cannot be resolved, then fails if the operator cannot recover it", async () => {
    const a = withBrokenLocator(loadArtifact("member.read_savings_balance"), "s2");
    const r = await replay(
      a,
      { memberId: "12345" },
      replayOpts({ broker: new AutoBroker({ decision: "abort", note: "cannot find the field" }) })
    );
    expect(r.status).toBe("failure");
    expect(r.failure?.category).toBe("locator_unresolved");
    const files = existsSync(r.evidence.dir) ? readdirSync(r.evidence.dir) : [];
    expect(files.some((f) => f.startsWith("intervention-"))).toBe(true);
  });
});
