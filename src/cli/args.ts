/** Minimal argv parser: flags (--name value / --flag) and repeatable --input k=v. */
export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
  inputs: Record<string, string>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const inputs: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (key === "input" && next) {
        const [k, ...v] = next.split("=");
        inputs[k] = v.join("=");
        i++;
      } else if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags, inputs };
}
