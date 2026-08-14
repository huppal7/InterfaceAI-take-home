/**
 * Seed data for the mock "MeridianCore" member-servicing console.
 *
 * This stands in for a legacy vendor core-banking product that many tenants run. It is a
 * proxy target: no real bank system, no real PII. Values are fictional.
 */
export interface Member {
  id: string;
  name: string;
  status: "active" | "restricted";
  savingsBalance: number; // dollars
  subAccounts: { id: string; type: string; balance: number }[];
}

export const MEMBERS: Record<string, Member> = {
  "10001": { id: "10001", name: "Ada Lovelace", status: "active", savingsBalance: 4215.5, subAccounts: [] },
  "10002": { id: "10002", name: "Alan Turing", status: "active", savingsBalance: 12000.0, subAccounts: [] },
  // Matches the brief's example goal ("look up member 12345 ... savings balance").
  "12345": { id: "12345", name: "Grace Hopper", status: "active", savingsBalance: 8742.19, subAccounts: [] },
  // 99999 exists but is restricted -> permission denial on detail view.
  "99999": { id: "99999", name: "Sealed Record", status: "restricted", savingsBalance: 0, subAccounts: [] },
  // 00000 intentionally absent -> "record not found" business outcome.
};

export const SUB_ACCOUNT_TYPES = ["Holiday Savings", "Emergency Fund", "Certificate (CD)"];

export function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
