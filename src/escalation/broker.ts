/**
 * Escalation brokers.
 *
 *  - FileBroker: real handoff. Writes the intervention request (with context + screenshot)
 *    to disk and polls for a decision written by the operator console. This is how a human
 *    operator — driving the SAME live headed browser — signals approve/deny/resume/abort.
 *
 *  - AutoBroker: a deliberately mocked operator for offline runs and tests. It optionally
 *    runs a callback that performs the manual step on the live driver (simulating the human
 *    taking control), then returns a preset decision. Clearly labeled; the handoff MECHANISM
 *    and control-transfer model are identical to the FileBroker path.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EscalationBroker, InterventionDecision, InterventionRequest } from "./types.js";

const POLL_ROOT = process.env.INTERVENTION_DIR ?? "evidence/_interventions";

export class FileBroker implements EscalationBroker {
  constructor(private pollMs = 1500, private timeoutMs = 10 * 60_000) {}

  async raise(req: InterventionRequest): Promise<InterventionDecision> {
    mkdirSync(POLL_ROOT, { recursive: true });
    const dir = join(POLL_ROOT, req.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "request.json"), JSON.stringify(req, null, 2));
    const decisionPath = join(dir, "decision.json");

    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(decisionPath)) {
        return JSON.parse(readFileSync(decisionPath, "utf8")) as InterventionDecision;
      }
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
    return { decision: "abort", note: "operator did not respond before timeout", at: new Date().toISOString() };
  }
}

export interface AutoBrokerConfig {
  decision: InterventionDecision["decision"];
  note?: string;
  /** Optional manual action to run on the live session before returning the decision. */
  manualAction?: () => Promise<{ description: string }>;
}

export class AutoBroker implements EscalationBroker {
  constructor(private cfg: AutoBrokerConfig) {}

  async raise(_req: InterventionRequest): Promise<InterventionDecision> {
    const humanActions: InterventionDecision["humanActions"] = [];
    if (this.cfg.manualAction) {
      const r = await this.cfg.manualAction();
      humanActions.push({ at: new Date().toISOString(), description: r.description });
    }
    return {
      decision: this.cfg.decision,
      note: this.cfg.note ?? "auto-operator (mock) decision",
      byOperator: "auto-operator",
      humanActions,
      at: new Date().toISOString(),
    };
  }
}
