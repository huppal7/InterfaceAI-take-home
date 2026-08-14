/**
 * CLI: deterministic replay of a saved capability (no LLM).
 *
 *   npx tsx src/cli/replay.ts <capabilityId> [--version v] --input k=v [...] \
 *     [--base-url http://localhost:4599] [--headed] [--attended] [--require-approval] \
 *     [--broker auto-approve|auto-deny|file]
 */
import { parseArgs } from "./args.js";
import { loadArtifact } from "../artifact/store.js";
import { replay } from "../replay/engine.js";
import { AutoBroker, FileBroker } from "../escalation/broker.js";
import type { EscalationBroker } from "../escalation/types.js";

async function main() {
  const { positionals, flags, inputs } = parseArgs(process.argv.slice(2));
  const capabilityId = positionals[0];
  if (!capabilityId) {
    console.error("usage: replay <capabilityId> --input k=v ...");
    process.exit(2);
  }
  const artifact = loadArtifact(capabilityId, typeof flags.version === "string" ? flags.version : undefined);
  const baseUrl = (flags["base-url"] as string) ?? "http://localhost:4599";

  let broker: EscalationBroker | undefined;
  if (flags.broker === "auto-approve") broker = new AutoBroker({ decision: "approve", note: "auto-approved (demo)" });
  else if (flags.broker === "auto-deny") broker = new AutoBroker({ decision: "deny", note: "auto-denied (demo)" });
  else if (flags.broker === "file") broker = new FileBroker();

  const result = await replay(artifact, inputs, {
    baseUrl,
    attended: !!flags.attended,
    headless: !flags.headed,
    requireApproval: !!flags["require-approval"],
    broker,
  });

  console.log("\n=== Replay result ===");
  console.log(`capability : ${result.capabilityId}@${result.capabilityVersion}`);
  console.log(`status     : ${result.status}`);
  if (result.outputs) console.log(`outputs    : ${JSON.stringify(result.outputs)}`);
  if (result.outcome) console.log(`outcome    : ${result.outcome.code} — ${result.outcome.message}`);
  if (result.failure) console.log(`failure    : [${result.failure.category}] ${result.failure.message}\n             expected=${result.failure.expected}\n             observed=${result.failure.observed}`);
  console.log(`duration   : ${result.durationMs}ms`);
  console.log(`evidence   : ${result.evidence.dir}`);
  console.log("steps:");
  for (const s of result.steps) console.log(`  [${s.status.padEnd(9)}] ${s.stepId} ${s.action} — ${s.description}${s.resolvedStrategy !== undefined ? ` (strategy #${s.resolvedStrategy})` : ""}${s.note ? ` :: ${s.note}` : ""}`);

  process.exit(result.status === "failure" ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
