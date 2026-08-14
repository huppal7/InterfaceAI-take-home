/**
 * Locator synthesis: turn an element the agent acted on (an ElementDescriptor from
 * perception) into a DURABLE Locator with an ordered fallback chain.
 *
 * Ordering principle (most robust first):
 *   1. role + accessible name  — survives markup churn; portable to desktop a11y trees.
 *   2. label                    — form fields tie to their visible label.
 *   3. placeholder              — stable hint text on inputs.
 *   4. text                     — button/link visible text.
 *   5. css by #id               — only when the id looks author-assigned (not framework noise).
 *
 * The ephemeral perception attribute (data-cu-ref) is deliberately NEVER emitted.
 */
import type { ElementDescriptor } from "../surface/types.js";
import type { Locator, LocatorStrategy } from "../types/artifact.js";

function looksStableId(id?: string): boolean {
  if (!id) return false;
  // Reject obviously generated ids (react-style :r0:, long hex, uuid-ish).
  if (/^:r|^[0-9a-f]{8,}$/i.test(id)) return false;
  if (/^\d+$/.test(id)) return false;
  return /^[a-z][a-z0-9_-]{0,30}$/i.test(id);
}

export function synthesizeLocator(el: ElementDescriptor, description?: string): Locator {
  const strategies: LocatorStrategy[] = [];

  if (el.name) {
    strategies.push({ kind: "role", role: el.role, name: el.name, exact: false });
  }
  if (el.attrs.labelText) {
    strategies.push({ kind: "label", value: el.attrs.labelText, exact: false });
  }
  if (el.attrs.placeholder) {
    strategies.push({ kind: "placeholder", value: el.attrs.placeholder });
  }
  if (el.text && (el.role === "button" || el.role === "link")) {
    strategies.push({ kind: "text", value: el.text, exact: false });
  }
  if (looksStableId(el.attrs.id)) {
    strategies.push({ kind: "css", value: `#${el.attrs.id}` });
  }
  // Guarantee at least one strategy: fall back to a role-only match.
  if (strategies.length === 0) {
    strategies.push({ kind: "role", role: el.role, exact: false });
  }

  const note = buildNote(strategies);
  return {
    description: description ?? el.name ?? `${el.role} control`,
    strategies,
    robustnessNote: note,
  };
}

function buildNote(strategies: LocatorStrategy[]): string {
  const primary = strategies[0];
  const primaryDesc =
    primary.kind === "role"
      ? `accessibility role="${primary.role}"${primary.name ? ` name="${primary.name}"` : ""}`
      : primary.kind;
  return (
    `Primary target is ${primaryDesc} (accessibility-first: robust to markup churn and portable to a11y trees). ` +
    `${strategies.length - 1} fallback(s) provide resilience if the primary drifts.`
  );
}

/**
 * Locator for a READABLE value element (a balance, a confirmation number). Its accessible
 * name is often its *value* (which changes per run), so role+name is NOT used. A stable id
 * is the primary target; text-adjacency by the row label is a fallback.
 */
export function synthesizeReadLocator(el: ElementDescriptor, description?: string): Locator {
  const strategies: LocatorStrategy[] = [];
  if (looksStableId(el.attrs.id)) strategies.push({ kind: "css", value: `#${el.attrs.id}` });
  if (el.role === "status" || el.role === "alert") strategies.push({ kind: "role", role: el.role, exact: false });
  if (strategies.length === 0 && el.attrs.id) strategies.push({ kind: "css", value: `#${el.attrs.id}` });
  if (strategies.length === 0) strategies.push({ kind: "css", value: el.tag });
  return {
    description: description ?? el.name ?? "value",
    strategies,
    robustnessNote: "Readable value: targeted by author-assigned id (value text is not used as a name because it varies per run).",
  };
}

/** Build a Locator that targets a static element by id/text (used for checkpoints). */
export function locatorFromCss(css: string, description: string): Locator {
  return { description, strategies: [{ kind: "css", value: css }] };
}
