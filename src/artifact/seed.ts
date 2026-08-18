/**
 * Seed reference artifacts (hand-authored) so replay, error-handling, escalation, and
 * tests are fully runnable WITHOUT an LLM/API key. The real discovery run (with a key)
 * emits its own artifact; replay treats both identically.
 *
 * Run: npx tsx src/artifact/seed.ts
 */
import { ARTIFACT_SCHEMA_VERSION, parseArtifact, type CapabilityArtifact } from "../types/artifact.js";
import { rulesForProduct } from "./rule-library.js";
import { saveArtifact } from "./store.js";

const APP = { vendor: "Meridian", product: "MemberServicing", appVersion: "8.2", surface: "legacy-web" as const };
const TENANT = { mode: "base" as const };
const nowMeta = (goal: string) => ({
  recordedAt: new Date().toISOString(),
  recordedBy: "hand-authored" as const,
  goal,
  approval: "approved" as const,
  notes: "Reference artifact used for offline replay/tests. Structurally identical to a discovered one.",
});

const readBalance: CapabilityArtifact = parseArtifact({
  schemaVersion: ARTIFACT_SCHEMA_VERSION,
  id: "member.read_savings_balance",
  version: "1.0.0",
  name: "Read member savings balance",
  description: "Look up a member by ID and return their current savings balance.",
  app: APP,
  tenant: TENANT,
  entry: { urlTemplate: "{baseUrl}/console" },
  inputs: [{ name: "memberId", type: "string", required: true, description: "Member identifier to look up.", sensitive: false, example: "12345" }],
  outputs: [{ name: "savingsBalance", type: "money", description: "Current savings balance in USD.", capturedByStep: "s4", sensitive: false }],
  steps: [
    {
      id: "s1", index: 0, action: "navigate", description: "Open the member-servicing console.", risk: "safe",
      value: { kind: "literal", value: "{baseUrl}/console" },
      wait: { until: "load", timeoutMs: 10000 },
      checkpoint: { type: "textPresent", text: "Member Lookup" },
    },
    {
      id: "s2", index: 1, action: "type", description: "Enter the Member ID into the lookup field.", risk: "safe",
      target: {
        description: "Member ID lookup field",
        strategies: [
          { kind: "role", role: "textbox", name: "Member ID", exact: false },
          { kind: "label", value: "Member ID", exact: false },
          { kind: "css", value: "#mid" },
        ],
        robustnessNote: "Accessibility role+name is primary; label and id are fallbacks.",
      },
      value: { kind: "param", param: "memberId" },
    },
    {
      id: "s3", index: 2, action: "click", description: "Submit the member lookup.", risk: "safe",
      target: {
        description: "Search button",
        strategies: [
          { kind: "role", role: "button", name: "Search", exact: false },
          { kind: "text", value: "Search", exact: false },
        ],
      },
      wait: { until: "load", timeoutMs: 10000 },
      checkpoint: { type: "textPresent", text: "Savings Balance" },
    },
    {
      id: "s4", index: 3, action: "read", description: "Read the savings balance from the member record.", risk: "safe",
      target: { description: "Savings balance value", strategies: [{ kind: "css", value: "#savings" }], robustnessNote: "Author-assigned id on the balance element; stable in this vendor product." },
      capture: { output: "savingsBalance", from: "text", normalize: "money" },
    },
  ],
  successCondition: { type: "textPresent", text: "Savings Balance" },
  runtimeRules: rulesForProduct(APP.vendor, APP.product),
  metadata: { ...nowMeta("Look up member 12345 and read their current savings balance.") },
});

const openSub: CapabilityArtifact = parseArtifact({
  schemaVersion: ARTIFACT_SCHEMA_VERSION,
  id: "member.open_sub_account",
  version: "1.0.0",
  name: "Open a new member sub-account",
  description: "Open a new sub-account for a member and reach the confirmation screen.",
  app: APP,
  tenant: TENANT,
  entry: { urlTemplate: "{baseUrl}/console" },
  inputs: [
    { name: "memberId", type: "string", required: true, description: "Member identifier.", sensitive: false, example: "10001" },
    { name: "accountType", type: "enum", required: true, description: "Type of sub-account to open.", enumValues: ["Holiday Savings", "Emergency Fund", "Certificate (CD)"], sensitive: false, example: "Holiday Savings" },
    { name: "initialDeposit", type: "money", required: true, description: "Opening deposit amount.", sensitive: false, example: "100.00" },
  ],
  outputs: [{ name: "confirmationNumber", type: "string", description: "Sub-account confirmation number.", capturedByStep: "s8", sensitive: false }],
  steps: [
    { id: "s1", index: 0, action: "navigate", description: "Open the console.", risk: "safe", value: { kind: "literal", value: "{baseUrl}/console" }, wait: { until: "load", timeoutMs: 10000 }, checkpoint: { type: "textPresent", text: "Member Lookup" } },
    {
      id: "s2", index: 1, action: "type", description: "Enter the Member ID.", risk: "safe",
      target: { description: "Member ID lookup field", strategies: [{ kind: "role", role: "textbox", name: "Member ID", exact: false }, { kind: "label", value: "Member ID", exact: false }, { kind: "css", value: "#mid" }] },
      value: { kind: "param", param: "memberId" },
    },
    { id: "s3", index: 2, action: "click", description: "Submit the lookup.", risk: "safe", target: { description: "Search button", strategies: [{ kind: "role", role: "button", name: "Search", exact: false }, { kind: "text", value: "Search", exact: false }] }, wait: { until: "load", timeoutMs: 10000 }, checkpoint: { type: "textPresent", text: "Savings Balance" } },
    {
      id: "s4", index: 3, action: "click", description: "Open the new sub-account form.", risk: "safe",
      target: { description: "Open new sub-account link", strategies: [{ kind: "role", role: "link", name: "Open new sub-account", exact: false }, { kind: "text", value: "Open new sub-account", exact: false }] },
      wait: { until: "load", timeoutMs: 10000 },
      checkpoint: { type: "textPresent", text: "Opening a new sub-account" },
    },
    {
      id: "s5", index: 4, action: "select", description: "Choose the account type.", risk: "safe",
      target: { description: "Account type dropdown", strategies: [{ kind: "role", role: "combobox", name: "Account type", exact: false }, { kind: "label", value: "Account type", exact: false }, { kind: "css", value: "#atype" }] },
      value: { kind: "param", param: "accountType" },
    },
    {
      id: "s6", index: 5, action: "type", description: "Enter the initial deposit.", risk: "safe",
      target: { description: "Initial deposit field", strategies: [{ kind: "role", role: "textbox", name: "Initial deposit", exact: false }, { kind: "label", value: "Initial deposit", exact: false }, { kind: "placeholder", value: "0.00" }, { kind: "css", value: "#dep" }] },
      value: { kind: "param", param: "initialDeposit" },
    },
    {
      id: "s7", index: 6, action: "click", description: "Open the sub-account (irreversible: creates a record).", risk: "risky",
      target: { description: "Open sub-account submit button", strategies: [{ kind: "role", role: "button", name: "Open sub-account", exact: false }, { kind: "text", value: "Open sub-account", exact: false }] },
      wait: { until: "load", timeoutMs: 10000 },
    },
    {
      id: "s8", index: 7, action: "read", description: "Read the confirmation number.", risk: "safe",
      target: { description: "Confirmation number", strategies: [{ kind: "css", value: "#confno" }] },
      capture: { output: "confirmationNumber", from: "text", normalize: "trim" },
    },
  ],
  successCondition: { type: "textPresent", text: "Sub-account opened" },
  runtimeRules: rulesForProduct(APP.vendor, APP.product),
  metadata: nowMeta("Open a new sub-account for this member and reach the confirmation screen."),
});

for (const a of [readBalance, openSub]) {
  const path = saveArtifact(a);
  console.log(`seeded ${a.id}@${a.version} -> ${path}`);
}
