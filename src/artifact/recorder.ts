/**
 * Recorder — assembles a CapabilityArtifact from a successful discovery run.
 *
 * The orchestrator calls these methods as the agent acts (mapping each acted-upon element,
 * captured during perception, into a durable Locator). At the end, `finalize` stamps
 * metadata, attaches the vendor product's authoritative runtime rules, and validates the
 * whole thing against the Zod schema before it is trusted.
 */
import {
  ARTIFACT_SCHEMA_VERSION,
  parseArtifact,
  type ActionType,
  type CapabilityArtifact,
  type Checkpoint,
  type InputParam,
  type OutputField,
  type Locator,
  type RiskClass,
  type Step,
  type ValueRef,
} from "../types/artifact.js";
import type { ElementDescriptor } from "../surface/types.js";
import { synthesizeLocator, synthesizeReadLocator } from "./locator-synth.js";
import { rulesForProduct } from "./rule-library.js";

export interface FinalizeInput {
  id: string;
  version: string;
  name: string;
  description: string;
  goal: string;
  model?: string;
  app: CapabilityArtifact["app"];
  tenant: CapabilityArtifact["tenant"];
  entryUrlTemplate: string;
  inputs: InputParam[];
  outputs: OutputField[];
  successCondition: Checkpoint;
  recordedBy?: "llm-discovery" | "human" | "hand-authored";
}

export class Recorder {
  private steps: Step[] = [];

  private nextStep(action: ActionType, description: string, risk: RiskClass = "safe"): Step {
    return { id: `s${this.steps.length + 1}`, index: this.steps.length, action, description, risk };
  }

  recordNavigate(urlTemplate: string, description: string, checkpoint?: Checkpoint): Step {
    const step = this.nextStep("navigate", description);
    step.value = { kind: "literal", value: urlTemplate };
    step.wait = { until: "load", timeoutMs: 10_000 };
    if (checkpoint) step.checkpoint = checkpoint;
    this.steps.push(step);
    return step;
  }

  recordType(el: ElementDescriptor, value: ValueRef, description: string): Step {
    const step = this.nextStep("type", description);
    step.target = synthesizeLocator(el, description);
    step.value = value;
    this.steps.push(step);
    return step;
  }

  recordClick(el: ElementDescriptor, description: string, risk: RiskClass = "safe", checkpoint?: Checkpoint): Step {
    const step = this.nextStep("click", description, risk);
    step.target = synthesizeLocator(el, description);
    step.wait = { until: "load", timeoutMs: 10_000 };
    if (checkpoint) step.checkpoint = checkpoint;
    this.steps.push(step);
    return step;
  }

  recordSelect(el: ElementDescriptor, value: ValueRef, description: string): Step {
    const step = this.nextStep("select", description);
    step.target = synthesizeLocator(el, description);
    step.value = value;
    this.steps.push(step);
    return step;
  }

  recordRead(el: ElementDescriptor, outputName: string, from: "text" | "value" | "attr", normalize: "none" | "money" | "trim" | "digits", description: string, attr?: string): Step {
    const step = this.nextStep("read", description);
    step.target = el.kind === "readable" ? synthesizeReadLocator(el, description) : synthesizeLocator(el, description);
    step.capture = { output: outputName, from, normalize, attr };
    this.steps.push(step);
    return step;
  }

  recordAssert(checkpoint: Checkpoint, description: string): Step {
    const step = this.nextStep("assert", description);
    step.checkpoint = checkpoint;
    this.steps.push(step);
    return step;
  }

  stepCount(): number {
    return this.steps.length;
  }

  finalize(meta: FinalizeInput): CapabilityArtifact {
    // Validate that every read step's output and every param binding is declared.
    const inputNames = new Set(meta.inputs.map((i) => i.name));
    const outputNames = new Set(meta.outputs.map((o) => o.name));
    for (const s of this.steps) {
      if (s.value?.kind === "param" && !inputNames.has(s.value.param)) {
        throw new Error(`step ${s.id} binds unknown input "${s.value.param}"`);
      }
      if (s.capture && !outputNames.has(s.capture.output)) {
        throw new Error(`step ${s.id} captures unknown output "${s.capture.output}"`);
      }
    }
    // Every declared output must be captured by some step.
    for (const o of meta.outputs) {
      const cap = this.steps.find((s) => s.capture?.output === o.name);
      if (!cap) throw new Error(`declared output "${o.name}" is not captured by any step`);
      o.capturedByStep = cap.id;
    }

    const artifact: CapabilityArtifact = {
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      id: meta.id,
      version: meta.version,
      name: meta.name,
      description: meta.description,
      app: meta.app,
      tenant: meta.tenant,
      entry: { urlTemplate: meta.entryUrlTemplate },
      inputs: meta.inputs,
      outputs: meta.outputs,
      steps: this.steps,
      successCondition: meta.successCondition,
      runtimeRules: rulesForProduct(meta.app.vendor, meta.app.product),
      metadata: {
        recordedAt: new Date().toISOString(),
        recordedBy: meta.recordedBy ?? "llm-discovery",
        model: meta.model,
        goal: meta.goal,
        approval: "draft",
      },
    };
    return parseArtifact(artifact); // schema-validate before returning
  }
}

/** Convenience: build the standard entry-navigate checkpoint for the console. */
export function consoleEntryCheckpoint(): Checkpoint {
  return { type: "textPresent", text: "Member Lookup" };
}
