/**
 * CLI: LLM-driven discovery run (the one step that must be real).
 *
 *   ANTHROPIC_API_KEY=... npx tsx src/cli/discover.ts \
 *     --goal "look up member 12345 and read their current savings balance" \
 *     [--base-url http://localhost:4599] [--headed] [--model claude-opus-5] [--version 1.0.0]
 */
import { parseArgs } from "./args.js";
import { discover } from "../agent/loop.js";
import { FileBroker } from "../escalation/broker.js";

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const goal = typeof flags.goal === "string" ? flags.goal : "look up member 12345 and read their current savings balance";
  const baseUrl = (flags["base-url"] as string) ?? "http://localhost:4599";

  const result = await discover({
    goal,
    baseUrl,
    app: { vendor: "Meridian", product: "MemberServicing", appVersion: "8.2", surface: "legacy-web" },
    version: typeof flags.version === "string" ? flags.version : "1.0.0",
    model: typeof flags.model === "string" ? flags.model : undefined,
    headless: !flags.headed,
    broker: flags.broker === "file" ? new FileBroker() : undefined,
  });

  console.log("\n=== Discovery result ===");
  console.log(`status         : ${result.status}`);
  console.log(`message        : ${result.message}`);
  console.log(`steps recorded : ${result.stepsRecorded}`);
  console.log(`evidence       : ${result.evidenceDir}`);
  if (result.artifactPath) {
    console.log(`artifact       : ${result.artifactPath}`);
    console.log(`capability     : ${result.artifact?.id}@${result.artifact?.version}`);
    console.log("\nNext: replay it deterministically, e.g.");
    console.log(`  npx tsx src/cli/replay.ts ${result.artifact?.id} --input ${result.artifact?.inputs[0]?.name}=${result.artifact?.inputs[0]?.example ?? "<value>"}`);
  }
  process.exit(result.status === "success" ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
