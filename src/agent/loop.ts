/**
 * Goal-driven discovery loop — the ONE part that must be a real LLM-driven run.
 *
 * The agent observes an accessibility-first snapshot (+ screenshot), decides one action,
 * and acts through the tool surface. The orchestrator executes each action against the
 * live surface, enforces the allowlist, and records it into a durable, parameterized
 * artifact. On success the agent supplies the typed capability contract and we finalize.
 */
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import type { AppIdentity, CapabilityArtifact, InputParam, OutputField } from "../types/artifact.js";
import { WebDriver } from "../surface/web-driver.js";
import type { Observation, SurfaceDriver } from "../surface/types.js";
import { Recorder } from "../artifact/recorder.js";
import { saveArtifact } from "../artifact/store.js";
import { RunContext } from "../evidence/run.js";
import { AGENT_TOOLS } from "./tools.js";
import { renderObservation, systemPrompt } from "./prompt.js";
import { checkNavigation, policyForBaseUrl, type AllowlistPolicy } from "../safety/policy.js";
import type { EscalationBroker } from "../escalation/types.js";
import { SessionController } from "../escalation/controller.js";

export interface DiscoverOptions {
  goal: string;
  baseUrl: string;
  app: AppIdentity;
  version?: string;
  model?: string;
  maxSteps?: number;
  headless?: boolean;
  operatorId?: string;
  policy?: AllowlistPolicy;
  broker?: EscalationBroker;
}

export interface DiscoverResult {
  status: "success" | "stuck" | "error";
  message: string;
  artifactPath?: string;
  artifact?: CapabilityArtifact;
  runId: string;
  evidenceDir: string;
  stepsRecorded: number;
}

const RISKY_VERB = /\b(open|submit|confirm|create|post|transfer|delete|pay|approve|remove)\b/i;

export async function discover(opts: DiscoverOptions): Promise<DiscoverResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is required for the discovery run (this is the one step that must use a real LLM).");
  }

  const model = opts.model ?? process.env.AGENT_MODEL ?? "claude-opus-5";
  const maxSteps = opts.maxSteps ?? 16;
  const policy = opts.policy ?? policyForBaseUrl(opts.baseUrl);
  const operatorId = opts.operatorId ?? process.env.OPERATOR_ID ?? "agent1";
  const run = new RunContext("discovery", opts.goal, [operatorId]);
  run.log("info", "discovery.start", { goal: opts.goal, model, baseUrl: opts.baseUrl });

  const client = new Anthropic();
  const driver: SurfaceDriver = new WebDriver({ headless: opts.headless ?? true });
  const controller = new SessionController((c) => run.log("info", "control.transfer", { controller: c }));
  const recorder = new Recorder();
  await driver.start();

  const finish = (r: Omit<DiscoverResult, "runId" | "evidenceDir" | "stepsRecorded">): DiscoverResult => {
    const res = { ...r, runId: run.runId, evidenceDir: run.dir, stepsRecorded: recorder.stepCount() };
    run.log("info", "discovery.finish", { status: res.status, message: res.message, stepsRecorded: res.stepsRecorded });
    return res;
  };

  try {
    // --- Session establishment (harness; not a recorded step) ---
    const loginUrl = `${opts.baseUrl}/login`;
    if (!checkNavigation(policy, loginUrl).allowed) throw new Error("login url not allowlisted");
    await driver.navigate(loginUrl);
    await driver.typeLocator({ description: "Operator ID", strategies: [{ kind: "label", value: "Operator ID", exact: false }] }, operatorId);
    await driver.clickLocator({ description: "Sign In", strategies: [{ kind: "role", role: "button", name: "Sign In", exact: false }] });
    run.log("info", "session.established", { operator: "[REDACTED]" });

    // --- Entry navigation (recorded as step s1) ---
    const entryUrl = `${opts.baseUrl}/console`;
    if (!checkNavigation(policy, entryUrl).allowed) throw new Error("entry url not allowlisted");
    await driver.navigate(entryUrl);
    recorder.recordNavigate("{baseUrl}/console", "Open the member-servicing console.", { type: "textPresent", text: "Member Lookup" });

    // --- Observe → decide → act ---
    let obs = await snap(driver, run, 0);
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: observationContent(renderObservation(opts.goal, obs, 0), obs.screenshotPath) }];

    for (let step = 1; step <= maxSteps; step++) {
      controller.assertAgentControls();
      const response = await client.messages.create({
        model,
        max_tokens: 4000,
        thinking: { type: "adaptive" },
        system: systemPrompt(),
        tools: AGENT_TOOLS,
        messages,
      } as Anthropic.MessageCreateParamsNonStreaming);
      messages.push({ role: "assistant", content: response.content });

      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const assistantText = response.content.filter((b) => b.type === "text").map((b: any) => b.text).join(" ").trim();
      if (assistantText) run.log("info", "agent.text", { text: run.scrubText(assistantText).slice(0, 500) });

      if (toolUses.length === 0) {
        // No action taken — nudge once, then treat as stuck.
        messages.push({ role: "user", content: [{ type: "text", text: "Take a single action with a tool, or call finish/escalate." }] });
        continue;
      }

      const primary = toolUses[0];
      run.log("decision", "agent.action", { tool: primary.name, input: run.scrubText(JSON.stringify(primary.input)) });

      // Handle terminal tools first.
      if (primary.name === "finish") {
        const input = primary.input as any;
        if (input.status === "success" && input.capability) {
          const artifact = finalize(recorder, input.capability, opts, model, run);
          const path = saveArtifact(artifact);
          run.writeJson("artifact.json", artifact);
          run.log("info", "artifact.saved", { path, id: artifact.id, version: artifact.version });
          return finish({ status: "success", message: input.message ?? "goal achieved", artifactPath: path, artifact });
        }
        return finish({ status: "stuck", message: input.message ?? "agent gave up" });
      }
      if (primary.name === "escalate") {
        const input = primary.input as any;
        controller.cedeToHuman();
        const decision = opts.broker
          ? await opts.broker.raise({
              id: `${run.runId}--escalate`,
              runId: run.runId,
              capabilityId: "(discovery)",
              goal: opts.goal,
              reason: input.reason ?? "stuck",
              currentUrl: driver.currentUrl(),
              observationText: run.scrubText(obs.readText).slice(0, 2000),
              screenshot: obs.screenshotPath,
              message: input.message,
              createdAt: new Date().toISOString(),
            })
          : { decision: "abort" as const, note: "no broker", at: new Date().toISOString() };
        controller.reclaim();
        run.log("decision", "escalation.resolved", { decision: decision.decision, note: decision.note });
        if (decision.decision === "abort" || decision.decision === "deny") {
          return finish({ status: "stuck", message: `escalation ${decision.decision}: ${input.message}` });
        }
        obs = await snap(driver, run, step);
        messages.push({ role: "user", content: toolResults(toolUses, primary.id, `Operator resolved: ${decision.decision}. ${decision.note ?? ""}\n\n` + renderObservation(opts.goal, obs, step), obs.screenshotPath) });
        continue;
      }

      // Actionable tools.
      const exec = await executeAgentAction(driver, primary, recorder, policy, run);
      obs = await snap(driver, run, step);
      const resultText = exec.error
        ? `ACTION FAILED: ${exec.error}\n\n${renderObservation(opts.goal, obs, step)}`
        : renderObservation(opts.goal, obs, step);
      messages.push({ role: "user", content: toolResults(toolUses, primary.id, resultText, obs.screenshotPath, !!exec.error) });
    }

    return finish({ status: "stuck", message: `reached max steps (${maxSteps}) without finishing` });
  } catch (e) {
    run.log("error", "discovery.exception", { error: String(e) });
    return finish({ status: "error", message: String(e) });
  } finally {
    await driver.close();
  }
}

// --- helpers ---

async function snap(driver: SurfaceDriver, run: RunContext, step: number): Promise<Observation> {
  const path = run.screenshotPath(`obs-${step}`);
  const obs = await driver.snapshot({ screenshot: true, screenshotPath: path });
  run.log("info", "observation", { step, url: obs.url, elements: obs.elements.length });
  return obs;
}

function screenshotBlock(path?: string): Anthropic.ImageBlockParam | undefined {
  if (!path) return undefined;
  try {
    const data = readFileSync(path).toString("base64");
    return { type: "image", source: { type: "base64", media_type: "image/png", data } };
  } catch {
    return undefined;
  }
}

function observationContent(text: string, screenshotPath?: string): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = [{ type: "text", text }];
  const img = screenshotBlock(screenshotPath);
  if (img) blocks.push(img);
  return blocks;
}

/** Build tool_result blocks: the primary tool gets the observation; extras get a nudge. */
function toolResults(
  toolUses: Anthropic.ToolUseBlock[],
  primaryId: string,
  primaryText: string,
  screenshotPath: string | undefined,
  isError = false
): Anthropic.ContentBlockParam[] {
  const out: Anthropic.ContentBlockParam[] = [];
  for (const t of toolUses) {
    if (t.id === primaryId) {
      const content: Anthropic.ToolResultBlockParam["content"] = [{ type: "text", text: primaryText }];
      const img = screenshotBlock(screenshotPath);
      if (img) (content as any[]).push(img);
      out.push({ type: "tool_result", tool_use_id: t.id, content, is_error: isError });
    } else {
      out.push({ type: "tool_result", tool_use_id: t.id, content: "Only one action is processed per turn. Re-observe and act again.", is_error: true });
    }
  }
  return out;
}

async function executeAgentAction(
  driver: SurfaceDriver,
  tool: Anthropic.ToolUseBlock,
  recorder: Recorder,
  policy: AllowlistPolicy,
  run: RunContext
): Promise<{ ok: boolean; error?: string }> {
  const input = tool.input as any;
  const urlBefore = driver.currentUrl();

  if (tool.name === "type") {
    const r = await driver.typeRef(input.ref, input.text);
    if (!r.ok || !r.element) return { ok: false, error: r.error ?? "type failed" };
    const value = input.bindToInput ? ({ kind: "param", param: input.bindToInput } as const) : ({ kind: "literal", value: input.text } as const);
    recorder.recordType(r.element, value, input.description);
    return { ok: true };
  }
  if (tool.name === "select") {
    const r = await driver.selectRef(input.ref, input.value);
    if (!r.ok || !r.element) return { ok: false, error: r.error ?? "select failed" };
    const value = input.bindToInput ? ({ kind: "param", param: input.bindToInput } as const) : ({ kind: "literal", value: input.value } as const);
    recorder.recordSelect(r.element, value, input.description);
    return { ok: true };
  }
  if (tool.name === "read") {
    const r = await driver.readRef(input.ref, input.from ?? "text", input.attr);
    if (!r.ok || !r.element) return { ok: false, error: r.error ?? "read failed" };
    recorder.recordRead(r.element, input.outputName, input.from ?? "text", input.normalize ?? "none", input.description, input.attr);
    run.log("info", "output.discovered", { name: input.outputName });
    return { ok: true };
  }
  if (tool.name === "click") {
    const r = await driver.clickRef(input.ref);
    if (!r.ok || !r.element) return { ok: false, error: r.error ?? "click failed" };
    await driver.waitFor({ until: "load", timeoutMs: 10000 });
    const urlAfter = driver.currentUrl();
    // Allowlist: a click must not take us off the allowlisted surface.
    const nav = checkNavigation(policy, urlAfter);
    if (!nav.allowed) {
      run.log("warn", "allowlist.blocked", { url: urlAfter, reason: nav.reason });
      return { ok: false, error: `navigation blocked by allowlist: ${nav.reason}` };
    }
    const risky = !!input.risky || (r.element.role === "button" && RISKY_VERB.test(r.element.name));
    const checkpoint = urlAfter !== urlBefore ? ({ type: "urlMatches", pattern: escapePath(urlAfter) } as const) : undefined;
    recorder.recordClick(r.element, input.description, risky ? "risky" : "safe", checkpoint);
    return { ok: true };
  }
  return { ok: false, error: `unknown tool ${tool.name}` };
}

function escapePath(url: string): string {
  try {
    const p = new URL(url).pathname;
    return "^" + p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(\\?.*)?$";
  } catch {
    return ".*";
  }
}

function finalize(recorder: Recorder, cap: any, opts: DiscoverOptions, model: string, run: RunContext): CapabilityArtifact {
  const inputs: InputParam[] = (cap.inputs ?? []).map((i: any) => ({
    name: i.name,
    type: i.type,
    required: i.required ?? true,
    description: i.description,
    enumValues: i.enumValues,
    sensitive: i.sensitive ?? false,
    example: i.example,
  }));
  const outputs: OutputField[] = (cap.outputs ?? []).map((o: any) => ({
    name: o.name,
    type: o.type,
    description: o.description,
    capturedByStep: "", // filled by recorder.finalize
    sensitive: o.sensitive ?? false,
  }));
  return recorder.finalize({
    id: cap.id,
    version: opts.version ?? "1.0.0",
    name: cap.name,
    description: cap.description,
    goal: opts.goal,
    model,
    app: opts.app,
    tenant: { mode: "base" },
    entryUrlTemplate: "{baseUrl}/console",
    inputs,
    outputs,
    successCondition: { type: "textPresent", text: cap.successConditionText },
    recordedBy: "llm-discovery",
  });
}
