/**
 * CLI: browse and invoke the capability catalog (agent-facing interface).
 *
 *   npx tsx src/cli/catalog.ts list
 *   npx tsx src/cli/catalog.ts describe <capabilityId>
 *   npx tsx src/cli/catalog.ts invoke <capabilityId> --input k=v [...] [--attended] [--broker auto-approve]
 */
import { parseArgs } from "./args.js";
import { describe, invoke, list } from "../catalog/catalog.js";
import { AutoBroker, FileBroker } from "../escalation/broker.js";
import type { EscalationBroker } from "../escalation/types.js";

async function main() {
  const { positionals, flags, inputs } = parseArgs(process.argv.slice(2));
  const cmd = positionals[0];

  if (cmd === "list") {
    const caps = list();
    if (caps.length === 0) return console.log("(no capabilities in catalog)");
    for (const c of caps) {
      const sig = c.inputs.map((i) => `${i.name}: ${i.type}${i.required ? "" : "?"}`).join(", ");
      const out = c.outputs.map((o) => `${o.name}: ${o.type}`).join(", ") || "void";
      console.log(`${c.id}@${c.version}  [${c.approval}]${c.hasRiskyStep ? " ⚠ risky" : ""}`);
      console.log(`  ${c.name} — ${c.description}`);
      console.log(`  (${sig}) -> { ${out} }\n`);
    }
    return;
  }

  if (cmd === "describe") {
    const id = positionals[1];
    if (!id) return console.error("usage: catalog describe <capabilityId>");
    console.log(JSON.stringify(describe(id), null, 2));
    return;
  }

  if (cmd === "invoke") {
    const id = positionals[1];
    if (!id) return console.error("usage: catalog invoke <capabilityId> --input k=v ...");
    let broker: EscalationBroker | undefined;
    if (flags.broker === "auto-approve") broker = new AutoBroker({ decision: "approve" });
    else if (flags.broker === "file") broker = new FileBroker();
    const result = await invoke(id, inputs, {
      baseUrl: (flags["base-url"] as string) ?? "http://localhost:4599",
      attended: !!flags.attended,
      headless: !flags.headed,
      broker,
    });
    console.log(JSON.stringify({ status: result.status, outputs: result.outputs, outcome: result.outcome, failure: result.failure, evidence: result.evidence.dir }, null, 2));
    process.exit(result.status === "failure" ? 1 : 0);
    return;
  }

  console.error("usage: catalog <list|describe|invoke>");
  process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
