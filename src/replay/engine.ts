/**
 * Deterministic replay — the production execution path an AI agent triggers.
 *
 * No LLM in the decision loop. Given a saved artifact + typed input params, it:
 *   - validates inputs against the typed contract,
 *   - enforces the allowlist on every navigation/action,
 *   - executes steps using stable locator fallback chains,
 *   - after each step, evaluates the artifact's runtime rules (the error taxonomy) and
 *     classifies conditions into business outcome / recoverable / hard failure,
 *   - handles risky steps per policy (escalating for confirmation when required),
 *   - verifies checkpoints and the overall success condition,
 *   - returns a structured ReplayResult with declared outputs, or an outcome, or a failure.
 */
import type { CapabilityArtifact, InputParam, RuntimeRule, Step, ValueRef } from "../types/artifact.js";
import type { ReplayResult, StepTrace } from "../types/result.js";
import type { SurfaceDriver } from "../surface/types.js";
import { WebDriver } from "../surface/web-driver.js";
import { RunContext } from "../evidence/run.js";
import {
  checkAction,
  checkNavigation,
  disposeRiskyStep,
  policyForBaseUrl,
  type AllowlistPolicy,
} from "../safety/policy.js";
import type { EscalationBroker, InterventionRequest } from "../escalation/types.js";
import { SessionController } from "../escalation/controller.js";

export interface ReplayOptions {
  baseUrl: string;
  policy?: AllowlistPolicy;
  /** Is a human operator online? Affects how risky steps are dispositioned. */
  attended?: boolean;
  broker?: EscalationBroker;
  /** Gate unattended replay on approval state (draft -> refuse). */
  requireApproval?: boolean;
  /** Service operator to sign in as (sensitive; redacted everywhere). */
  operatorId?: string;
  headless?: boolean;
  slowMo?: number;
  /** Provide a driver (tests); otherwise a WebDriver is created. */
  driver?: SurfaceDriver;
  /** Evidence directory root. Tests write under a gitignored folder. */
  evidenceRoot?: string;
  /** Stable run-id (folder name) for curated evidence capture. */
  evidenceRunId?: string;
}

interface ValidatedInputs {
  ok: boolean;
  values: Record<string, string | number | boolean>;
  errors: string[];
  sensitiveValues: string[];
}

export function validateInputs(inputs: InputParam[], provided: Record<string, string>): ValidatedInputs {
  const values: Record<string, string | number | boolean> = {};
  const errors: string[] = [];
  const sensitiveValues: string[] = [];
  for (const p of inputs) {
    const raw = provided[p.name];
    if (raw === undefined || raw === "") {
      if (p.required) errors.push(`missing required input "${p.name}"`);
      continue;
    }
    if (p.sensitive) sensitiveValues.push(raw);
    switch (p.type) {
      case "number":
      case "money": {
        const n = Number(String(raw).replace(/[$,]/g, ""));
        if (Number.isNaN(n)) errors.push(`input "${p.name}" must be a number`);
        else values[p.name] = n;
        break;
      }
      case "boolean":
        values[p.name] = raw === "true" || raw === "1";
        break;
      case "enum":
        if (p.enumValues && !p.enumValues.includes(raw)) errors.push(`input "${p.name}" must be one of ${p.enumValues.join(", ")}`);
        else values[p.name] = raw;
        break;
      default:
        values[p.name] = raw;
    }
  }
  return { ok: errors.length === 0, values, errors, sensitiveValues };
}

function resolveValue(v: ValueRef | undefined, params: Record<string, string>): string | undefined {
  if (!v) return undefined;
  return v.kind === "literal" ? v.value : params[v.param];
}

function normalize(value: string, how: string): string | number {
  switch (how) {
    case "money":
      return Number(value.replace(/[$,\s]/g, ""));
    case "digits":
      return value.replace(/\D/g, "");
    case "trim":
      return value.trim();
    default:
      return value.trim();
  }
}

export async function replay(
  artifact: CapabilityArtifact,
  rawParams: Record<string, string>,
  opts: ReplayOptions
): Promise<ReplayResult> {
  const policy = opts.policy ?? policyForBaseUrl(opts.baseUrl);
  const attended = opts.attended ?? false;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  // Param values as strings for step binding (keep raw for locators/values).
  const stringParams: Record<string, string> = { ...rawParams };

  const validation = validateInputs(artifact.inputs, rawParams);
  const operatorId = opts.operatorId ?? process.env.OPERATOR_ID ?? "agent1";
  const sensitive = [...validation.sensitiveValues, operatorId];

  const run = new RunContext("replay", `${artifact.id}`, sensitive, opts.evidenceRoot ?? "evidence", opts.evidenceRunId);
  run.log("info", "replay.start", { capabilityId: artifact.id, version: artifact.version, params: redactParamsForLog(artifact.inputs, rawParams) });

  const steps: StepTrace[] = [];
  const outputs: Record<string, string | number | boolean> = {};

  function finish(partial: Omit<ReplayResult, "capabilityId" | "capabilityVersion" | "steps" | "evidence" | "startedAt" | "finishedAt" | "durationMs">): ReplayResult {
    const finishedAt = new Date().toISOString();
    const result: ReplayResult = {
      capabilityId: artifact.id,
      capabilityVersion: artifact.version,
      ...partial,
      steps,
      evidence: { runId: run.runId, logPath: run.logPath, dir: run.dir, screenshots: run.screenshots },
      startedAt,
      finishedAt,
      durationMs: Date.now() - t0,
    };
    run.log("info", "replay.finish", { status: result.status, outcome: result.outcome, failure: result.failure });
    run.writeJson("result.json", result);
    return result;
  }

  // Approval gate.
  if (opts.requireApproval && artifact.metadata.approval !== "approved") {
    run.log("warn", "replay.blocked.approval", { approval: artifact.metadata.approval });
    return finish({ status: "failure", failure: { category: "policy_blocked", expected: "approved capability", observed: artifact.metadata.approval, message: "Unattended replay requires an approved capability." } });
  }

  // Input validation gate.
  if (!validation.ok) {
    run.log("error", "replay.invalid_inputs", { errors: validation.errors });
    return finish({ status: "failure", failure: { category: "hard_failure", expected: "valid inputs", observed: validation.errors.join("; "), message: "Input validation failed." } });
  }

  const driver = opts.driver ?? new WebDriver({ headless: opts.headless ?? true, slowMo: opts.slowMo });
  const controller = new SessionController((c) => run.log("info", "control.transfer", { controller: c }));
  const ownsDriver = !opts.driver;
  if (ownsDriver) await driver.start();

  try {
    // --- Session establishment harness (not a recorded step): sign in ---
    const loginUrl = `${opts.baseUrl}/login`;
    const navCheck = checkNavigation(policy, loginUrl);
    if (!navCheck.allowed) throw new Error(`allowlist blocked login: ${navCheck.reason}`);
    await driver.navigate(loginUrl);
    await driver.typeLocator({ description: "Operator ID", strategies: [{ kind: "label", value: "Operator ID", exact: false }] }, operatorId);
    await driver.clickLocator({ description: "Sign In", strategies: [{ kind: "role", role: "button", name: "Sign In", exact: false }] });
    run.log("info", "session.established", { operator: "[REDACTED]" });

    // --- Execute recorded steps ---
    for (const step of artifact.steps) {
      controller.assertAgentControls();
      const sTrace: StepTrace = { stepId: step.id, index: step.index, action: step.action, description: step.description, status: "ok", startedAt: new Date().toISOString(), durationMs: 0 };
      const st0 = Date.now();

      // Allowlist: action type.
      const actCheck = checkAction(policy, step.action);
      if (!actCheck.allowed) {
        sTrace.status = "failed";
        sTrace.durationMs = Date.now() - st0;
        steps.push(sTrace);
        return finish({ status: "failure", failure: { stepId: step.id, stepIndex: step.index, category: "policy_blocked", expected: "allowlisted action", observed: step.action, message: actCheck.reason } });
      }

      // Risky-step handling.
      if (step.risk === "risky") {
        const disp = disposeRiskyStep(policy, attended);
        run.log("decision", "risky_step", { stepId: step.id, disposition: disp, description: step.description });
        if (disp === "blocked") {
          sTrace.status = "failed";
          steps.push(sTrace);
          return finish({ status: "failure", failure: { stepId: step.id, stepIndex: step.index, category: "policy_blocked", expected: "operator approval", observed: "risky step blocked by policy", message: `Risky step "${step.description}" blocked (policy=block).` } });
        }
        if (disp === "needs_confirmation") {
          const decision = await escalate(driver, run, controller, opts.broker, {
            reason: "risky_confirmation",
            capabilityId: artifact.id,
            goal: artifact.metadata.goal,
            stepId: step.id,
            stepIndex: step.index,
            message: `Risky/irreversible step requires confirmation: "${step.description}".`,
          });
          run.log("decision", "risky_step.decision", { stepId: step.id, decision: decision.decision, note: decision.note });
          if (decision.decision !== "approve" && decision.decision !== "resume") {
            sTrace.status = "failed";
            steps.push(sTrace);
            return finish({ status: "failure", failure: { stepId: step.id, stepIndex: step.index, category: "escalation_unresolved", expected: "operator approval", observed: decision.decision, message: `Risky step not approved (${decision.decision}).` } });
          }
        }
      }

      // Navigation allowlist check for navigate steps.
      const rawUrl = resolveValue(step.value, stringParams);
      if (step.action === "navigate" && rawUrl) {
        const url = substitute(rawUrl, opts.baseUrl, stringParams);
        const nc = checkNavigation(policy, url);
        if (!nc.allowed) {
          sTrace.status = "failed";
          steps.push(sTrace);
          return finish({ status: "failure", failure: { stepId: step.id, stepIndex: step.index, category: "policy_blocked", expected: "allowlisted url", observed: url, message: nc.reason } });
        }
        await driver.navigate(url);
      }

      // Execute the action.
      const exec = await executeStep(driver, step, stringParams, run);
      if (!exec.ok && exec.escalatable && opts.broker) {
        // Stuck: locator did not resolve -> hand off, then retry once.
        const decision = await escalate(driver, run, controller, opts.broker, {
          reason: "stuck",
          capabilityId: artifact.id,
          goal: artifact.metadata.goal,
          stepId: step.id,
          stepIndex: step.index,
          message: `Replay could not resolve the target for step "${step.description}". Operator assistance requested.`,
        });
        if (decision.decision === "resume" || decision.decision === "approve") {
          const retry = await executeStep(driver, step, stringParams, run);
          exec.ok = retry.ok;
          exec.error = retry.error;
          sTrace.status = retry.ok ? "recovered" : "failed";
          if (decision.humanActions?.length) sTrace.note = decision.humanActions.map((h) => h.description).join("; ");
        } else {
          sTrace.status = "failed";
        }
      }
      if (!exec.ok) {
        sTrace.status = "failed";
        sTrace.durationMs = Date.now() - st0;
        sTrace.screenshot = run.screenshotPath(`fail-${step.id}`);
        await driver.screenshot(sTrace.screenshot);
        steps.push(sTrace);
        return finish({ status: "failure", failure: { stepId: step.id, stepIndex: step.index, category: "locator_unresolved", expected: `resolve "${step.target?.description ?? step.action}"`, observed: exec.error ?? "unresolved", message: `Step "${step.description}" could not execute.` } });
      }
      sTrace.resolvedStrategy = exec.resolvedStrategy;

      // Capture output on read steps.
      if (step.action === "read" && step.capture && step.target) {
        const r = await driver.readLocator(step.target, step.capture.from, step.capture.attr);
        if (!r.ok || r.value === undefined) {
          sTrace.status = "failed";
          steps.push(sTrace);
          return finish({ status: "failure", failure: { stepId: step.id, stepIndex: step.index, category: "checkpoint_failed", expected: `read ${step.capture.output}`, observed: r.error ?? "no value", message: `Could not read declared output "${step.capture.output}".` } });
        }
        outputs[step.capture.output] = normalize(r.value, step.capture.normalize);
        run.log("info", "output.captured", { name: step.capture.output });
      }

      // Runtime-rule evaluation (error taxonomy) after the step.
      const ruleResult = await evaluateRules(artifact.runtimeRules, driver, run);
      if (ruleResult) {
        const { rule } = ruleResult;
        if (rule.classify === "business_outcome") {
          sTrace.status = "ok";
          sTrace.note = `business outcome: ${rule.outcomeCode}`;
          sTrace.durationMs = Date.now() - st0;
          steps.push(sTrace);
          run.log("info", "business_outcome", { code: rule.outcomeCode, rule: rule.name });
          return finish({ status: "business_outcome", outcome: { code: rule.outcomeCode ?? rule.name, message: rule.message } });
        }
        if (rule.classify === "hard_failure") {
          sTrace.status = "failed";
          sTrace.durationMs = Date.now() - st0;
          sTrace.screenshot = run.screenshotPath(`fail-${step.id}`);
          await driver.screenshot(sTrace.screenshot);
          steps.push(sTrace);
          run.log("error", "hard_failure", { rule: rule.name });
          return finish({ status: "failure", failure: { stepId: step.id, stepIndex: step.index, category: "hard_failure", expected: "normal state", observed: rule.name, message: rule.message } });
        }
        if (rule.classify === "recoverable") {
          sTrace.status = "recovered";
          sTrace.note = `recovered: ${rule.name}`;
          run.log("info", "recovered", { rule: rule.name });
          // recovery already applied inside evaluateRules
        }
      }

      // Step checkpoint (proves we reached expected state) — after rule handling.
      if (step.checkpoint) {
        const cp = await driver.evaluateCheckpoint(step.checkpoint);
        if (!cp.ok) {
          sTrace.status = "failed";
          sTrace.durationMs = Date.now() - st0;
          sTrace.screenshot = run.screenshotPath(`fail-${step.id}`);
          await driver.screenshot(sTrace.screenshot);
          steps.push(sTrace);
          return finish({ status: "failure", failure: { stepId: step.id, stepIndex: step.index, category: "checkpoint_failed", expected: JSON.stringify(step.checkpoint), observed: cp.observed, message: `Checkpoint failed after "${step.description}".` } });
        }
      }

      sTrace.durationMs = Date.now() - st0;
      steps.push(sTrace);
      run.log("info", "step.ok", { stepId: step.id, action: step.action, resolvedStrategy: exec.resolvedStrategy });
    }

    // Overall success condition.
    const success = await driver.evaluateCheckpoint(artifact.successCondition);
    const endShot = run.screenshotPath("final");
    await driver.screenshot(endShot);
    if (!success.ok) {
      return finish({ status: "failure", failure: { category: "checkpoint_failed", expected: JSON.stringify(artifact.successCondition), observed: success.observed, message: "Success condition not met at end of run." } });
    }
    return finish({ status: "success", outputs });
  } catch (e) {
    run.log("error", "replay.exception", { error: String(e) });
    return finish({ status: "failure", failure: { category: "hard_failure", expected: "no exception", observed: String(e), message: "Unhandled exception during replay." } });
  } finally {
    if (ownsDriver) await driver.close();
  }
}

// --- helpers ---

function substitute(template: string, baseUrl: string, params: Record<string, string>): string {
  let out = template.replace(/\{baseUrl\}/g, baseUrl);
  for (const [k, v] of Object.entries(params)) out = out.replace(new RegExp(`\\{${k}\\}`, "g"), v);
  return out;
}

async function executeStep(
  driver: SurfaceDriver,
  step: Step,
  params: Record<string, string>,
  run: RunContext
): Promise<{ ok: boolean; resolvedStrategy?: number; error?: string; escalatable?: boolean }> {
  const value = resolveValue(step.value, params);
  try {
    switch (step.action) {
      case "navigate":
        return { ok: true }; // navigation already performed by caller
      case "type": {
        if (!step.target || value === undefined) return { ok: false, error: "type step missing target/value" };
        const r = await driver.typeLocator(step.target, value);
        return { ok: r.ok, resolvedStrategy: r.strategyIndex, error: r.error, escalatable: !r.ok };
      }
      case "select": {
        if (!step.target || value === undefined) return { ok: false, error: "select step missing target/value" };
        const r = await driver.selectLocator(step.target, value);
        return { ok: r.ok, resolvedStrategy: r.strategyIndex, error: r.error, escalatable: !r.ok };
      }
      case "click": {
        if (!step.target) return { ok: false, error: "click step missing target" };
        const r = await driver.clickLocator(step.target);
        if (step.wait) await driver.waitFor({ until: step.wait.until, selector: step.wait.selector, text: step.wait.text, timeoutMs: step.wait.timeoutMs });
        return { ok: r.ok, resolvedStrategy: r.strategyIndex, error: r.error, escalatable: !r.ok };
      }
      case "read":
        return { ok: true }; // capture handled by caller
      case "waitFor":
        if (step.wait) await driver.waitFor({ until: step.wait.until, selector: step.wait.selector, text: step.wait.text, timeoutMs: step.wait.timeoutMs });
        return { ok: true };
      case "assert":
        return { ok: true }; // checkpoint evaluated by caller
    }
  } catch (e) {
    run.log("error", "step.exception", { stepId: step.id, error: String(e) });
    return { ok: false, error: String(e) };
  }
}

async function evaluateRules(
  rules: RuntimeRule[],
  driver: SurfaceDriver,
  run: RunContext
): Promise<{ rule: RuntimeRule } | undefined> {
  for (const rule of rules) {
    const cp = await driver.evaluateCheckpoint(rule.when);
    if (!cp.ok) continue;
    run.log("info", "runtime_rule.fired", { rule: rule.name, classify: rule.classify });
    if (rule.classify === "recoverable" && rule.recovery) {
      await applyRecovery(driver, rule, run);
      // Re-evaluate: if still present, escalate by returning as hard for the caller.
      const again = await driver.evaluateCheckpoint(rule.when);
      if (again.ok) {
        run.log("warn", "recovery.ineffective", { rule: rule.name });
        return { rule: { ...rule, classify: "hard_failure", message: `Recovery for "${rule.name}" did not clear the condition.` } };
      }
    }
    return { rule };
  }
  return undefined;
}

async function applyRecovery(driver: SurfaceDriver, rule: RuntimeRule, run: RunContext) {
  const rec = rule.recovery!;
  if (rec.kind === "dismissDialog") {
    const ok = await driver.dismissDialogIfPresent();
    run.log("info", "recovery.dismissDialog", { ok });
  } else if (rec.kind === "click") {
    await driver.clickLocator(rec.target);
    run.log("info", "recovery.click", { target: rec.target.description });
  } else if (rec.kind === "waitRetry") {
    for (let i = 0; i < rec.maxAttempts; i++) {
      await driver.waitFor({ until: "timeout", timeoutMs: rec.timeoutMs });
      const still = await driver.evaluateCheckpoint(rule.when);
      if (!still.ok) break;
    }
    run.log("info", "recovery.waitRetry", {});
  }
}

async function escalate(
  driver: SurfaceDriver,
  run: RunContext,
  controller: SessionController,
  broker: EscalationBroker | undefined,
  ctx: { reason: InterventionRequest["reason"]; capabilityId: string; goal: string; stepId?: string; stepIndex?: number; message: string }
) {
  const shot = run.screenshotPath(`escalation-${ctx.stepId ?? "run"}`);
  await driver.screenshot(shot);
  const obs = await driver.snapshot();
  const req: InterventionRequest = {
    id: `${run.runId}--${ctx.stepId ?? "run"}`,
    runId: run.runId,
    capabilityId: ctx.capabilityId,
    goal: ctx.goal,
    reason: ctx.reason,
    stepId: ctx.stepId,
    stepIndex: ctx.stepIndex,
    currentUrl: driver.currentUrl(),
    observationText: run.scrubText(obs.readText).slice(0, 2000),
    screenshot: shot,
    message: ctx.message,
    createdAt: new Date().toISOString(),
  };
  run.log("decision", "escalation.raised", { reason: ctx.reason, stepId: ctx.stepId, message: ctx.message });
  run.writeJson(`intervention-${ctx.stepId ?? "run"}.json`, req);

  // Control transfer: pause automation, cede the live session to the human.
  controller.cedeToHuman();
  const decision = broker
    ? await broker.raise(req)
    : { decision: "abort" as const, note: "no broker configured", at: new Date().toISOString() };
  controller.reclaim();

  run.log("decision", "escalation.resolved", { decision: decision.decision, note: decision.note, humanActions: decision.humanActions });
  return decision;
}

function redactParamsForLog(inputs: InputParam[], provided: Record<string, string>): Record<string, unknown> {
  const sensitiveNames = new Set(inputs.filter((i) => i.sensitive).map((i) => i.name));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(provided)) out[k] = sensitiveNames.has(k) ? "[REDACTED]" : v;
  return out;
}
