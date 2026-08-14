/**
 * Agent-facing capability catalog (stretch goal).
 *
 * Saved artifacts are exposed as a catalog of callable capabilities: an AI agent can
 * discover them, read their typed signature (as a tool/function schema), and invoke one by
 * name with typed args — which triggers deterministic replay. This is the production
 * "invoke a capability" surface, decoupled from discovery.
 */
import type { CapabilityArtifact } from "../types/artifact.js";
import { listArtifacts, loadArtifact } from "../artifact/store.js";
import { replay, type ReplayOptions } from "../replay/engine.js";
import type { ReplayResult } from "../types/result.js";

export interface CapabilitySummary {
  id: string;
  version: string;
  name: string;
  description: string;
  approval: string;
  hasRiskyStep: boolean;
  inputs: { name: string; type: string; required: boolean }[];
  outputs: { name: string; type: string }[];
}

export function summarize(a: CapabilityArtifact): CapabilitySummary {
  return {
    id: a.id,
    version: a.version,
    name: a.name,
    description: a.description,
    approval: a.metadata.approval,
    hasRiskyStep: a.steps.some((s) => s.risk === "risky"),
    inputs: a.inputs.map((i) => ({ name: i.name, type: i.type, required: i.required })),
    outputs: a.outputs.map((o) => ({ name: o.name, type: o.type })),
  };
}

export function list(): CapabilitySummary[] {
  return listArtifacts().map(summarize);
}

/** JSON-schema tool definition — the shape an agent's function-calling layer would consume. */
export function toToolSchema(a: CapabilityArtifact) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of a.inputs) {
    const t = p.type === "money" || p.type === "number" ? "number" : p.type === "boolean" ? "boolean" : "string";
    properties[p.name] = { type: t, description: p.description, ...(p.enumValues ? { enum: p.enumValues } : {}) };
    if (p.required) required.push(p.name);
  }
  return {
    name: a.id.replace(/\./g, "_"),
    description: `${a.description} Returns: ${a.outputs.map((o) => `${o.name} (${o.type})`).join(", ") || "no outputs"}.`,
    input_schema: { type: "object", properties, required },
    _meta: { capabilityId: a.id, version: a.version, approval: a.metadata.approval, hasRiskyStep: a.steps.some((s) => s.risk === "risky") },
  };
}

export function describe(id: string, version?: string) {
  return toToolSchema(loadArtifact(id, version));
}

/** Invoke a capability by name with typed args -> deterministic replay. */
export async function invoke(id: string, params: Record<string, string>, opts: ReplayOptions, version?: string): Promise<ReplayResult> {
  const artifact = loadArtifact(id, version);
  return replay(artifact, params, opts);
}
