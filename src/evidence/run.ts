/**
 * Evidence & observability.
 *
 * Every run (discovery or replay) gets a directory under /evidence with:
 *   - events.jsonl : a structured, append-only log of what happened and why
 *   - *.png        : screenshots (always at start/end; extra on failure/escalation)
 *   - result.json  : the final structured result (replay) or artifact pointer (discovery)
 *
 * All log payloads pass through redaction so regulated data never lands on disk.
 */
import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scrub, redactValues } from "../safety/redaction.js";

export type LogLevel = "info" | "warn" | "error" | "decision";

export class RunContext {
  readonly runId: string;
  readonly dir: string;
  readonly logPath: string;
  readonly screenshots: string[] = [];
  private seq = 0;

  constructor(kind: "discovery" | "replay" | "escalation", label: string, private sensitiveValues: string[] = [], root = "evidence") {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const slug = label.replace(/[^a-z0-9]+/gi, "-").slice(0, 40).toLowerCase();
    this.runId = `${kind}-${slug}-${stamp}`;
    this.dir = join(root, this.runId);
    mkdirSync(this.dir, { recursive: true });
    this.logPath = join(this.dir, "events.jsonl");
  }

  setSensitive(values: string[]) {
    this.sensitiveValues = values;
  }

  private redact(v: unknown): unknown {
    if (typeof v === "string") return redactValues(v, this.sensitiveValues);
    if (Array.isArray(v)) return v.map((x) => this.redact(x));
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) o[k] = this.redact(val);
      return o;
    }
    return v;
  }

  log(level: LogLevel, event: string, data: Record<string, unknown> = {}) {
    const line = {
      ts: new Date().toISOString(),
      seq: this.seq++,
      level,
      event,
      ...(this.redact(data) as Record<string, unknown>),
    };
    appendFileSync(this.logPath, JSON.stringify(line) + "\n");
    return line;
  }

  /** Path for a labeled screenshot; caller writes the actual file via the driver. */
  screenshotPath(label: string): string {
    const name = `${String(this.seq).padStart(3, "0")}-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`;
    const p = join(this.dir, name);
    this.screenshots.push(p);
    return p;
  }

  writeJson(name: string, obj: unknown) {
    writeFileSync(join(this.dir, name), JSON.stringify(this.redact(obj), null, 2));
  }

  /** Scrub arbitrary text for embedding in a summary. */
  scrubText(s: string): string {
    return scrub(redactValues(s, this.sensitiveValues));
  }
}
