/**
 * Capture curated replay evidence (no LLM) for /evidence.
 *
 * Starts its own mock app, runs the documented scenarios, writes stable folders
 * with logs + screenshots + result.json, then exits.
 *
 *   npx tsx src/cli/capture-evidence.ts
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { loadArtifact } from "../artifact/store.js";
import { replay, type ReplayOptions } from "../replay/engine.js";
import { AutoBroker } from "../escalation/broker.js";
import { launchMockApp } from "../mock-app/launch.js";
import type { CapabilityArtifact } from "../types/artifact.js";

const PORT = 4799;
const BASE = `http://localhost:${PORT}`;
const ROOT = "evidence";

function withNavigateUrl(artifact: CapabilityArtifact, urlTemplate: string): CapabilityArtifact {
  return {
    ...artifact,
    steps: artifact.steps.map((s) =>
      s.action === "navigate" ? { ...s, value: { kind: "literal" as const, value: urlTemplate } } : s
    ),
  };
}

async function run(runId: string, artifact: CapabilityArtifact, inputs: Record<string, string>, extra: Partial<ReplayOptions> = {}) {
  const r = await replay(artifact, inputs, {
    baseUrl: BASE,
    headless: true,
    evidenceRoot: ROOT,
    evidenceRunId: runId,
    ...extra,
  });
  console.log(`${runId}: ${r.status}${r.outcome ? ` ${r.outcome.code}` : ""}${r.failure ? ` ${r.failure.category}` : ""}`);
  return r;
}

async function main() {
  const app = await launchMockApp(PORT);
  try {
    const read = loadArtifact("member.read_savings_balance");
    const open = loadArtifact("member.open_sub_account");

    const curated = [
      "replay-success-read-balance",
      "replay-business-outcome-no-such-member",
      "replay-business-outcome-permission-denied",
      "replay-risky-approved",
      "replay-validation-error",
      "replay-recoverable-interstitial",
    ];
    for (const id of curated) {
      try {
        rmSync(join(ROOT, id), { recursive: true, force: true });
      } catch {
        /* ok */
      }
    }

    await run("replay-success-read-balance", read, { memberId: "12345" });
    await run("replay-business-outcome-no-such-member", read, { memberId: "00000" });
    await run("replay-business-outcome-permission-denied", read, { memberId: "99999" });
    await run("replay-risky-approved", open, { memberId: "10001", accountType: "Holiday Savings", initialDeposit: "250" }, {
      broker: new AutoBroker({ decision: "approve", note: "auto-approved (curated evidence)" }),
    });
    await run("replay-validation-error", open, { memberId: "10001", accountType: "Emergency Fund", initialDeposit: "-50" }, {
      attended: true,
    });
    await run("replay-recoverable-interstitial", withNavigateUrl(read, "{baseUrl}/console?notice=1"), { memberId: "12345" });
  } finally {
    app.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
