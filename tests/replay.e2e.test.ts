/**
 * End-to-end replay tests against the live mock app (no LLM). Exercises the core loop and
 * the full error taxonomy: success, business outcomes, recoverable, and escalation.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { loadArtifact } from "../src/artifact/store.js";
import { replay } from "../src/replay/engine.js";
import { AutoBroker } from "../src/escalation/broker.js";

const PORT = 4699;
const BASE = `http://localhost:${PORT}`;
let app: ChildProcess;

async function waitForApp(url: string, tries = 40): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("mock app did not start");
}

beforeAll(async () => {
  app = spawn("npx", ["tsx", "src/mock-app/server.ts"], { env: { ...process.env, APP_PORT: String(PORT), FORCE_NOTICE: "0" }, stdio: "ignore" });
  await waitForApp(`${BASE}/login`);
});

afterAll(() => {
  app?.kill();
});

describe("deterministic replay — core loop", () => {
  it("reads a member savings balance (success + typed output)", async () => {
    const a = loadArtifact("member.read_savings_balance");
    const r = await replay(a, { memberId: "12345" }, { baseUrl: BASE, headless: true });
    expect(r.status).toBe("success");
    expect(r.outputs?.savingsBalance).toBe(8742.19);
    // Resolved via the primary (accessibility) strategy.
    expect(r.steps.find((s) => s.stepId === "s2")?.resolvedStrategy).toBe(0);
  });

  it("opens a sub-account through the risky step with operator approval", async () => {
    const a = loadArtifact("member.open_sub_account");
    const r = await replay(a, { memberId: "10001", accountType: "Holiday Savings", initialDeposit: "150" }, { baseUrl: BASE, headless: true, broker: new AutoBroker({ decision: "approve" }) });
    expect(r.status).toBe("success");
    expect(String(r.outputs?.confirmationNumber)).toMatch(/^SA-10001-/);
  });
});

describe("error taxonomy — business outcomes are NOT failures", () => {
  it('returns NO_SUCH_MEMBER as a business outcome for a missing member', async () => {
    const a = loadArtifact("member.read_savings_balance");
    const r = await replay(a, { memberId: "00000" }, { baseUrl: BASE, headless: true });
    expect(r.status).toBe("business_outcome");
    expect(r.outcome?.code).toBe("NO_SUCH_MEMBER");
  });

  it("returns PERMISSION_DENIED as a business outcome for a restricted member", async () => {
    const a = loadArtifact("member.read_savings_balance");
    const r = await replay(a, { memberId: "99999" }, { baseUrl: BASE, headless: true });
    expect(r.status).toBe("business_outcome");
    expect(r.outcome?.code).toBe("PERMISSION_DENIED");
  });

  it("returns VALIDATION_ERROR when the server rejects a value that passed the input contract", async () => {
    const a = loadArtifact("member.open_sub_account");
    const r = await replay(a, { memberId: "10001", accountType: "Emergency Fund", initialDeposit: "-5" }, { baseUrl: BASE, headless: true, attended: true });
    expect(r.status).toBe("business_outcome");
    expect(r.outcome?.code).toBe("VALIDATION_ERROR");
  });
});

describe("safety & escalation", () => {
  it("rejects a non-numeric money input at the contract boundary (hard failure, before acting)", async () => {
    const a = loadArtifact("member.open_sub_account");
    const r = await replay(a, { memberId: "10001", accountType: "Holiday Savings", initialDeposit: "abc" }, { baseUrl: BASE, headless: true, attended: true });
    expect(r.status).toBe("failure");
    expect(r.failure?.category).toBe("hard_failure");
    expect(r.steps.length).toBe(0); // never touched the browser
  });

  it("refuses an irreversible step unattended with no operator (escalation unresolved)", async () => {
    const a = loadArtifact("member.open_sub_account");
    const r = await replay(a, { memberId: "10001", accountType: "Holiday Savings", initialDeposit: "100" }, { baseUrl: BASE, headless: true });
    expect(r.status).toBe("failure");
    expect(r.failure?.category).toBe("escalation_unresolved");
  });

  it("gates unattended replay on approval state", async () => {
    const a = loadArtifact("member.read_savings_balance");
    const draft = { ...a, metadata: { ...a.metadata, approval: "draft" as const } };
    const r = await replay(draft, { memberId: "12345" }, { baseUrl: BASE, headless: true, requireApproval: true });
    expect(r.status).toBe("failure");
    expect(r.failure?.category).toBe("policy_blocked");
  });
});
