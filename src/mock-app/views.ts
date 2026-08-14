/**
 * Server-rendered HTML for the mock legacy console.
 *
 * Deliberately "legacy": table-based layout, inline styles, non-semantic markup, and —
 * critically — NO data-testid attributes anywhere. Automation must rely on what a human
 * operator sees: field labels, button text, and accessibility roles. Buttons/inputs do
 * carry proper labels and roles (as most real enterprise apps do), which is exactly the
 * accessibility-first surface our locator strategy targets.
 */
import { money, type Member } from "./data.js";

const CHROME = (title: string, body: string, banner = "MeridianCore — Member Servicing") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>
  body{font-family:Verdana,Geneva,sans-serif;font-size:13px;color:#12232e;background:#e9eef2;margin:0}
  .topbar{background:#12395b;color:#fff;padding:8px 14px;font-weight:bold;letter-spacing:.5px}
  .wrap{padding:14px}
  table{border-collapse:collapse;background:#fff;border:1px solid #9db2c4}
  td,th{border:1px solid #cdd8e2;padding:6px 10px;vertical-align:top}
  th{background:#dbe6ef;text-align:left}
  input[type=text],input[type=password],select{border:1px solid #7f97ab;padding:4px;font-size:13px}
  button,input[type=submit]{background:#245c8a;color:#fff;border:1px solid #16395b;padding:5px 12px;cursor:pointer}
  .err{background:#fbe3e4;border:1px solid #c33;color:#900;padding:8px 10px;margin:8px 0}
  .notice-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}
  .notice-box{background:#fff;border:2px solid #12395b;padding:18px 22px;max-width:380px}
  .muted{color:#5b6b78}
  a{color:#245c8a}
</style></head>
<body><div class="topbar">${banner}</div><div class="wrap">${body}</div></body></html>`;

export function loginPage(reason?: string): string {
  const msg =
    reason === "timeout"
      ? `<div class="err" role="alert">Your session has timed out. Please sign in again.</div>`
      : reason === "denied"
      ? `<div class="err" role="alert">You do not have permission to perform that action.</div>`
      : "";
  return CHROME(
    "Sign In",
    `${msg}
    <table><tr><td>
      <form method="post" action="/login">
        <table>
          <tr><td><label for="u">Operator ID</label></td><td><input type="text" id="u" name="username" autocomplete="off"></td></tr>
          <tr><td><label for="p">Password</label></td><td><input type="password" id="p" name="password"></td></tr>
          <tr><td colspan="2"><input type="submit" value="Sign In"></td></tr>
        </table>
      </form>
    </td></tr></table>
    <p class="muted">Demo console. Any non-empty credentials sign in. Operator <b>teller1</b> has limited rights (cannot open sub-accounts).</p>`
  );
}

export function consolePage(operator: string, opts: { notice?: boolean } = {}): string {
  // A "classic view" iframe/frameset panel is embedded to mirror legacy surfaces that
  // nest deeply framed content. The search form itself is on the main document.
  const noticeModal = opts.notice
    ? `<div class="notice-overlay" role="dialog" aria-label="System Notice"><div class="notice-box">
         <b>System Notice</b>
         <p>Scheduled maintenance window this weekend. Batch posting may be delayed.</p>
         <form method="get" action="/console"><button type="submit" name="ack" value="1">Continue</button></form>
       </div></div>`
    : "";
  return CHROME(
    "Console",
    `${noticeModal}
     <p>Signed in as <b>${operator}</b> &middot; <a href="/logout">Sign out</a></p>
     <table><tr><th>Member Lookup</th></tr>
       <tr><td>
         <form method="get" action="/members">
           <label for="mid">Member ID</label>
           <input type="text" id="mid" name="memberId" autocomplete="off">
           <button type="submit">Search</button>
         </form>
       </td></tr>
     </table>
     <p class="muted">Classic account snapshot (framed):</p>
     <iframe name="snapshot" title="Account Snapshot" src="/snapshot" width="480" height="90" style="border:1px solid #9db2c4;background:#fff"></iframe>`
  );
}

export function snapshotFrame(): string {
  return CHROME(
    "Snapshot",
    `<table><tr><th>Branch</th><td>0042 — Downtown</td><th>Teller Window</th><td>3</td></tr></table>`,
    "Account Snapshot"
  );
}

export function memberNotFound(memberId: string): string {
  return CHROME(
    "Not Found",
    `<div class="err" role="alert">No member found for ID "${memberId}".</div>
     <p><a href="/console">Back to lookup</a></p>`
  );
}

export function permissionDenied(): string {
  return CHROME(
    "Access Restricted",
    `<div class="err" role="alert">Access to this member record is restricted. Additional authorization is required.</div>
     <p><a href="/console">Back to lookup</a></p>`
  );
}

export function memberDetail(m: Member): string {
  const subs = m.subAccounts.length
    ? m.subAccounts.map((s) => `<tr><td>${s.id}</td><td>${s.type}</td><td>${money(s.balance)}</td></tr>`).join("")
    : `<tr><td colspan="3" class="muted">No sub-accounts on file.</td></tr>`;
  return CHROME(
    `Member ${m.id}`,
    `<table>
       <tr><th>Member</th><td>${m.name}</td></tr>
       <tr><th>Member ID</th><td>${m.id}</td></tr>
       <tr><th>Status</th><td>${m.status}</td></tr>
       <tr><th>Savings Balance</th><td><b id="savings">${money(m.savingsBalance)}</b></td></tr>
     </table>
     <h4>Sub-accounts</h4>
     <table><tr><th>ID</th><th>Type</th><th>Balance</th></tr>${subs}</table>
     <p><a href="/members/${m.id}/sub-account/new">Open new sub-account</a> &middot; <a href="/console">Back to lookup</a></p>`
  );
}

export function subAccountForm(m: Member, types: string[], error?: string): string {
  const errBox = error ? `<div class="err" role="alert">${error}</div>` : "";
  const options = types.map((t) => `<option value="${t}">${t}</option>`).join("");
  return CHROME(
    "Open Sub-account",
    `${errBox}
     <p>Opening a new sub-account for <b>${m.name}</b> (Member ${m.id}).</p>
     <form method="post" action="/members/${m.id}/sub-account">
       <table>
         <tr><td><label for="atype">Account type</label></td><td><select id="atype" name="accountType">${options}</select></td></tr>
         <tr><td><label for="dep">Initial deposit</label></td><td><input type="text" id="dep" name="initialDeposit" placeholder="0.00"></td></tr>
         <tr><td colspan="2"><button type="submit">Open sub-account</button> &middot; <a href="/members/${m.id}">Cancel</a></td></tr>
       </table>
     </form>`
  );
}

export function confirmationPage(m: Member, sub: { id: string; type: string; balance: number }): string {
  return CHROME(
    "Confirmation",
    `<table>
       <tr><th colspan="2">Sub-account opened</th></tr>
       <tr><th>Confirmation #</th><td><b id="confno">${sub.id}</b></td></tr>
       <tr><th>Member</th><td>${m.name} (${m.id})</td></tr>
       <tr><th>Type</th><td>${sub.type}</td></tr>
       <tr><th>Opening balance</th><td>${money(sub.balance)}</td></tr>
     </table>
     <p role="status">The sub-account was created successfully.</p>
     <p><a href="/members/${m.id}">View member</a></p>`
  );
}

export function appError(): string {
  return CHROME(
    "System Error",
    `<div class="err" role="alert">An unexpected system error occurred (reference 500-ADM). Please retry.</div>`
  );
}
