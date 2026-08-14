/**
 * Mock "MeridianCore" member-servicing console — the concrete surface we automate.
 *
 * Fault injection (drives the replay error-taxonomy demos), all deterministic:
 *   - member "00000"            -> record-not-found          (business outcome)
 *   - member "99999"            -> permission denied         (business outcome / policy)
 *   - operator "teller1"        -> cannot open sub-accounts  (permission denial on POST)
 *   - invalid initialDeposit    -> validation error          (business outcome)
 *   - ?fault=slow               -> transient slowness         (recoverable: wait/retry)
 *   - ?fault=timeout            -> session expired            (recoverable or hard)
 *   - ?fault=error              -> 500 app error              (hard failure)
 *   - /console?notice=1         -> unexpected interstitial    (recoverable: dismiss)
 */
import express from "express";
import type { Request, Response } from "express";
import { MEMBERS, SUB_ACCOUNT_TYPES, type Member } from "./data.js";
import * as V from "./views.js";

const PORT = Number(process.env.APP_PORT ?? 4599);
const app = express();
app.use(express.urlencoded({ extended: false }));

// --- tiny cookie helpers (no dependency) ---
function getCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}
function setCookie(res: Response, name: string, value: string) {
  res.setHeader("Set-Cookie", `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`);
}

function operatorOf(req: Request): string | undefined {
  return getCookie(req, "op");
}

async function maybeFault(req: Request, res: Response): Promise<boolean> {
  const fault = String(req.query.fault ?? "");
  if (fault === "slow") await new Promise((r) => setTimeout(r, 2500));
  if (fault === "timeout") {
    res.redirect("/login?reason=timeout");
    return true;
  }
  if (fault === "error") {
    res.status(500).send(V.appError());
    return true;
  }
  return false;
}

/** Guard protected routes; redirect to login if no session. */
function requireSession(req: Request, res: Response): string | undefined {
  const op = operatorOf(req);
  if (!op) {
    res.redirect("/login?reason=timeout");
    return undefined;
  }
  return op;
}

app.get("/", (_req, res) => res.redirect("/console"));

app.get("/login", (req, res) => res.send(V.loginPage(String(req.query.reason ?? ""))));

app.post("/login", (req, res) => {
  const username = String(req.body.username ?? "").trim();
  if (!username) return res.send(V.loginPage("denied"));
  setCookie(res, "op", username);
  res.redirect("/console");
});

app.get("/logout", (_req, res) => {
  setCookie(res, "op", "");
  res.redirect("/login");
});

app.get("/snapshot", (_req, res) => res.send(V.snapshotFrame()));

app.get("/console", async (req, res) => {
  if (await maybeFault(req, res)) return;
  const op = requireSession(req, res);
  if (!op) return;
  // notice modal shows unless acknowledged (?ack=1). FORCE_NOTICE makes it appear on every
  // console load until acknowledged — used to demo the recoverable-interstitial replay path.
  const forced = process.env.FORCE_NOTICE === "1";
  const notice = (req.query.notice === "1" || forced) && req.query.ack !== "1";
  res.send(V.consolePage(op, { notice }));
});

app.get("/members", async (req, res) => {
  if (await maybeFault(req, res)) return;
  const op = requireSession(req, res);
  if (!op) return;
  const memberId = String(req.query.memberId ?? "").trim();
  const m = MEMBERS[memberId];
  if (!m) return res.status(404).send(V.memberNotFound(memberId));
  if (m.status === "restricted") return res.status(403).send(V.permissionDenied());
  res.send(V.memberDetail(m));
});

app.get("/members/:id", async (req, res) => {
  if (await maybeFault(req, res)) return;
  const op = requireSession(req, res);
  if (!op) return;
  const m = MEMBERS[req.params.id];
  if (!m) return res.status(404).send(V.memberNotFound(req.params.id));
  if (m.status === "restricted") return res.status(403).send(V.permissionDenied());
  res.send(V.memberDetail(m));
});

app.get("/members/:id/sub-account/new", async (req, res) => {
  if (await maybeFault(req, res)) return;
  const op = requireSession(req, res);
  if (!op) return;
  const m = MEMBERS[req.params.id];
  if (!m || m.status === "restricted") return res.status(404).send(V.memberNotFound(req.params.id));
  res.send(V.subAccountForm(m, SUB_ACCOUNT_TYPES));
});

app.post("/members/:id/sub-account", async (req, res) => {
  if (await maybeFault(req, res)) return;
  const op = requireSession(req, res);
  if (!op) return;
  const m = MEMBERS[req.params.id];
  if (!m || m.status === "restricted") return res.status(404).send(V.memberNotFound(req.params.id));

  // Permission tier: teller1 may not open sub-accounts.
  if (op === "teller1") return res.status(403).redirect("/login?reason=denied");

  const accountType = String(req.body.accountType ?? "");
  const depositRaw = String(req.body.initialDeposit ?? "").trim();
  const deposit = Number(depositRaw.replace(/[$,]/g, ""));
  if (!SUB_ACCOUNT_TYPES.includes(accountType)) {
    return res.send(V.subAccountForm(m, SUB_ACCOUNT_TYPES, "Please choose a valid account type."));
  }
  if (depositRaw === "" || Number.isNaN(deposit) || deposit < 0) {
    return res.send(V.subAccountForm(m, SUB_ACCOUNT_TYPES, "Initial deposit must be a non-negative number."));
  }

  const sub = { id: `SA-${m.id}-${(m.subAccounts.length + 1).toString().padStart(2, "0")}`, type: accountType, balance: deposit };
  m.subAccounts.push(sub);
  res.send(V.confirmationPage(m, sub));
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[mock-app] MeridianCore console on http://localhost:${PORT}`);
});
