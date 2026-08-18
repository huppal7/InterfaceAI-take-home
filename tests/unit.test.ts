import { describe, it, expect } from "vitest";
import { scrub, redactValues, redactParams } from "../src/safety/redaction.js";
import { checkNavigation, checkAction, disposeRiskyStep, DEFAULT_POLICY } from "../src/safety/policy.js";
import { synthesizeLocator, synthesizeReadLocator } from "../src/artifact/locator-synth.js";
import { validateInputs } from "../src/replay/engine.js";
import { parseArtifact } from "../src/types/artifact.js";
import { loadArtifact } from "../src/artifact/store.js";
import { list, toToolSchema } from "../src/catalog/catalog.js";
import { SessionController } from "../src/escalation/controller.js";
import { parseArgs } from "../src/cli/args.js";
import type { ElementDescriptor } from "../src/surface/types.js";

describe("redaction", () => {
  it("scrubs secret-ish key/value pairs and long digit runs", () => {
    expect(scrub("password=hunter2")).toContain("[REDACTED]");
    expect(scrub("card 4111111111111111 used")).toContain("[REDACTED-****1111]");
    expect(scrub("ssn 123-45-6789")).toContain("[REDACTED-ID]");
  });
  it("redacts known sensitive values", () => {
    expect(redactValues("operator=teller-secret", ["teller-secret"])).toBe("operator=[REDACTED]");
  });
  it("redacts named params", () => {
    const out = redactParams({ password: "x", memberId: "123" }, new Set(["password"]));
    expect(out.password).toBe("[REDACTED]");
    expect(out.memberId).toBe("123");
  });
});

describe("allowlist policy", () => {
  it("allows in-policy navigation and blocks others", () => {
    expect(checkNavigation(DEFAULT_POLICY, "http://localhost:4599/members?memberId=1").allowed).toBe(true);
    expect(checkNavigation(DEFAULT_POLICY, "http://evil.example/x").allowed).toBe(false);
    expect(checkNavigation(DEFAULT_POLICY, "http://localhost:4599/admin/delete").allowed).toBe(false);
  });
  it("gates action types", () => {
    expect(checkAction(DEFAULT_POLICY, "click").allowed).toBe(true);
    expect(checkAction({ ...DEFAULT_POLICY, allowedActions: ["click"] }, "type").allowed).toBe(false);
  });
  it("disposes risky steps by mode", () => {
    expect(disposeRiskyStep({ ...DEFAULT_POLICY, riskyStepMode: "block" }, false)).toBe("blocked");
    expect(disposeRiskyStep({ ...DEFAULT_POLICY, riskyStepMode: "confirm" }, false)).toBe("needs_confirmation");
    expect(disposeRiskyStep(DEFAULT_POLICY, true)).toBe("flagged"); // attended proceeds
  });
});

describe("locator synthesis", () => {
  const el: ElementDescriptor = {
    ref: "e0",
    kind: "interactive",
    role: "textbox",
    name: "Member ID",
    tag: "input",
    attrs: { id: "mid", labelText: "Member ID", placeholder: "id" },
  };
  it("orders accessibility-first with fallbacks", () => {
    const loc = synthesizeLocator(el);
    expect(loc.strategies[0]).toMatchObject({ kind: "role", role: "textbox", name: "Member ID" });
    expect(loc.strategies.some((s) => s.kind === "label")).toBe(true);
    expect(loc.strategies.some((s) => s.kind === "css")).toBe(true); // #mid is stable
    // Never emits the ephemeral perception attribute.
    expect(JSON.stringify(loc)).not.toContain("data-cu-ref");
  });
  it("targets readable values by id, not by their (varying) value", () => {
    const val: ElementDescriptor = { ref: "r0", kind: "readable", role: "text", name: "Savings Balance", tag: "b", text: "$1.00", attrs: { id: "savings" } };
    const loc = synthesizeReadLocator(val);
    expect(loc.strategies[0]).toEqual({ kind: "css", value: "#savings" });
    expect(loc.strategies.every((s) => !(s.kind === "role" && (s as any).name === "$1.00"))).toBe(true);
  });
});

describe("input validation (typed contract boundary)", () => {
  const inputs = [
    { name: "memberId", type: "string" as const, required: true, description: "", sensitive: false },
    { name: "amount", type: "money" as const, required: true, description: "", sensitive: false },
    { name: "kind", type: "enum" as const, required: true, description: "", enumValues: ["a", "b"], sensitive: false },
  ];
  it("accepts valid inputs and coerces money", () => {
    const r = validateInputs(inputs, { memberId: "1", amount: "$1,200.50", kind: "a" });
    expect(r.ok).toBe(true);
    expect(r.values.amount).toBe(1200.5);
  });
  it("rejects bad types, missing required, and bad enum", () => {
    expect(validateInputs(inputs, { memberId: "1", amount: "abc", kind: "a" }).ok).toBe(false);
    expect(validateInputs(inputs, { amount: "1", kind: "a" }).ok).toBe(false);
    expect(validateInputs(inputs, { memberId: "1", amount: "1", kind: "z" }).ok).toBe(false);
  });
});

describe("artifact schema", () => {
  it("seed artifacts parse and round-trip", () => {
    const a = loadArtifact("member.read_savings_balance");
    expect(() => parseArtifact(a)).not.toThrow();
    expect(a.steps.length).toBeGreaterThan(0);
    expect(a.runtimeRules.some((r) => r.classify === "business_outcome")).toBe(true);
  });
});

describe("capability catalog", () => {
  it("lists saved capabilities with typed signatures", () => {
    const caps = list();
    expect(caps.map((c) => c.id)).toEqual(expect.arrayContaining(["member.read_savings_balance", "member.open_sub_account"]));
    const read = caps.find((c) => c.id === "member.read_savings_balance")!;
    expect(read.inputs).toEqual([{ name: "memberId", type: "string", required: true }]);
    expect(read.hasRiskyStep).toBe(false);
    expect(caps.find((c) => c.id === "member.open_sub_account")?.hasRiskyStep).toBe(true);
  });

  it("emits a JSON tool/function schema a calling agent could invoke", () => {
    const schema = toToolSchema(loadArtifact("member.read_savings_balance"));
    expect(schema.name).toBe("member_read_savings_balance");
    expect(schema.input_schema).toMatchObject({
      type: "object",
      required: ["memberId"],
      properties: { memberId: { type: "string" } },
    });
  });
});

describe("session control transfer", () => {
  it("blocks automation from acting while a human holds the session", () => {
    const seen: string[] = [];
    const c = new SessionController((who) => seen.push(who));
    expect(c.who()).toBe("agent");
    c.assertAgentControls();
    c.cedeToHuman();
    expect(c.who()).toBe("human");
    expect(() => c.assertAgentControls()).toThrow(/human holds control/);
    c.reclaim();
    expect(c.who()).toBe("agent");
    c.assertAgentControls();
    expect(seen).toEqual(["human", "agent"]);
  });
});

describe("CLI args", () => {
  it("parses repeatable --input flags and boolean switches", () => {
    const p = parseArgs(["member.read_savings_balance", "--input", "memberId=12345", "--headed", "--base-url", "http://localhost:4599"]);
    expect(p.positionals).toEqual(["member.read_savings_balance"]);
    expect(p.inputs).toEqual({ memberId: "12345" });
    expect(p.flags.headed).toBe(true);
    expect(p.flags["base-url"]).toBe("http://localhost:4599");
  });
});
