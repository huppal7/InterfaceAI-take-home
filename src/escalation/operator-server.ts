/**
 * Mock operator console — the human side of the handoff.
 *
 * Scope note (per brief): a full real-time co-browsing console is out of scope. This is the
 * minimal-but-real version: the automation runs a HEADED browser, and THAT window IS the
 * live session the operator takes over (drive it directly). This page carries the
 * intervention context (which capability/goal, current step, state, screenshot, and why it
 * stopped) and records the operator's decision, which the waiting FileBroker picks up to
 * resume/complete the run. The handoff mechanism and control-transfer model are real; only
 * the co-browsing UI is mocked.
 */
import express from "express";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { InterventionDecision, InterventionRequest } from "./types.js";

const PORT = Number(process.env.OPERATOR_PORT ?? 4600);
const ROOT = process.env.INTERVENTION_DIR ?? "evidence/_interventions";
const app = express();
app.use(express.urlencoded({ extended: false }));

function pending(): { id: string; req: InterventionRequest }[] {
  if (!existsSync(ROOT)) return [];
  return readdirSync(ROOT)
    .filter((d) => existsSync(join(ROOT, d, "request.json")) && !existsSync(join(ROOT, d, "decision.json")))
    .map((d) => ({ id: d, req: JSON.parse(readFileSync(join(ROOT, d, "request.json"), "utf8")) as InterventionRequest }));
}

app.get("/", (_req, res) => {
  const items = pending();
  const rows = items
    .map(
      ({ id, req }) => `
    <div style="border:1px solid #9db2c4;background:#fff;margin:10px 0;padding:12px">
      <h3 style="margin:0 0 6px">${req.reason.toUpperCase()} — ${req.capabilityId}</h3>
      <p style="margin:4px 0"><b>Goal:</b> ${escapeHtml(req.goal)}</p>
      <p style="margin:4px 0"><b>Why stopped:</b> ${escapeHtml(req.message)}</p>
      <p style="margin:4px 0"><b>Step:</b> ${req.stepId ?? "—"} &middot; <b>URL:</b> ${escapeHtml(req.currentUrl)}</p>
      <details><summary>Observed state (redacted)</summary><pre style="white-space:pre-wrap;background:#f3f6f9;padding:8px">${escapeHtml(req.observationText)}</pre></details>
      ${req.screenshot ? `<p><img src="/shot?path=${encodeURIComponent(req.screenshot)}" style="max-width:640px;border:1px solid #ccc"></p>` : ""}
      <div style="background:#fff6d6;border:1px solid #d9c36b;padding:8px;margin:8px 0">
        You now hold control of the <b>live browser window</b> the automation was using. Perform any manual steps there, then record your decision below.
      </div>
      <form method="post" action="/decide">
        <input type="hidden" name="id" value="${id}">
        <label>Note (what you did): <input type="text" name="note" size="50"></label><br>
        <button name="decision" value="approve">Approve &amp; resume</button>
        <button name="decision" value="resume">Resume (I fixed it)</button>
        <button name="decision" value="deny">Deny</button>
        <button name="decision" value="abort">Abort</button>
      </form>
    </div>`
    )
    .join("");
  res.send(`<!doctype html><html><head><title>Operator Console</title></head>
  <body style="font-family:Verdana,sans-serif;background:#e9eef2;padding:16px">
    <div style="background:#12395b;color:#fff;padding:8px 14px;font-weight:bold">Operator Console — Human-in-the-loop</div>
    <p>Controller shown per run in the automation log. Pending interventions: <b>${items.length}</b> (auto-refreshes).</p>
    ${rows || "<p>No pending interventions.</p>"}
    <script>setTimeout(() => location.reload(), 3000)</script>
  </body></html>`);
});

app.get("/shot", (req, res) => {
  const p = resolve(String(req.query.path ?? ""));
  // Only serve files inside the evidence tree.
  if (!p.startsWith(resolve("evidence"))) return res.status(403).send("forbidden");
  if (!existsSync(p)) return res.status(404).send("not found");
  res.sendFile(p);
});

app.post("/decide", (req, res) => {
  const id = String(req.body.id);
  const decision = String(req.body.decision) as InterventionDecision["decision"];
  const note = String(req.body.note ?? "");
  const dir = join(ROOT, id);
  mkdirSync(dir, { recursive: true });
  const out: InterventionDecision = {
    decision,
    note,
    byOperator: "operator@console",
    humanActions: note ? [{ at: new Date().toISOString(), description: note }] : [],
    at: new Date().toISOString(),
  };
  writeFileSync(join(dir, "decision.json"), JSON.stringify(out, null, 2));
  res.redirect("/");
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

app.listen(PORT, () => {
  console.log(`[operator] console on http://localhost:${PORT} (watching ${ROOT})`);
});
