/**
 * Redaction — never persist secrets or raw sensitive data into artifacts or logs.
 *
 * Two mechanisms:
 *  1. Field-level: input parameters marked `sensitive` have their VALUES redacted wherever
 *     they would otherwise be written (step values in the artifact, log lines, evidence).
 *  2. Pattern-level: a defensive scrub for anything that looks like a secret/PII slipping
 *     through free-text (long digit runs resembling full account/card/SSN numbers,
 *     password/token key=value pairs).
 *
 * Note: recorded steps store PARAMETER REFERENCES ({kind:"param"}), not literal values, so
 * sensitive values never enter the artifact by construction. This is defense in depth.
 */

type Replacer = string | ((match: string, ...args: any[]) => string);
const PATTERNS: { re: RegExp; replace: Replacer }[] = [
  // key=value or "key": "value" for secret-ish keys
  { re: /\b(password|passwd|pwd|secret|token|apikey|api_key|authorization|ssn)\b(\s*[:=]\s*)("?)([^"\s,&]+)\3/gi, replace: "$1$2$3[REDACTED]$3" },
  // 9-digit SSN-like
  { re: /\b\d{3}-?\d{2}-?\d{4}\b/g, replace: "[REDACTED-ID]" },
  // 12-19 digit runs (account/card numbers) — keep last 4
  { re: /\b\d{12,19}\b/g, replace: (m: string) => `[REDACTED-****${m.slice(-4)}]` },
];

export function scrub(text: string): string {
  let out = text;
  for (const { re, replace } of PATTERNS) {
    out = typeof replace === "string" ? out.replace(re, replace) : out.replace(re, replace);
  }
  return out;
}

/** Redact known sensitive parameter values (exact substring match) from a string. */
export function redactValues(text: string, sensitiveValues: string[]): string {
  let out = text;
  for (const v of sensitiveValues) {
    if (v && v.length >= 2) out = out.split(v).join("[REDACTED]");
  }
  return scrub(out);
}

/** Redact a params object for logging, given which params are sensitive. */
export function redactParams(
  params: Record<string, unknown>,
  sensitiveNames: Set<string>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    out[k] = sensitiveNames.has(k) ? "[REDACTED]" : typeof v === "string" ? scrub(v) : v;
  }
  return out;
}
