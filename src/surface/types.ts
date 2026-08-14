/**
 * Surface abstraction — the seam between perception/action and the recorded flow.
 *
 * A SurfaceDriver knows how to *perceive* the current state (as an accessibility-first
 * observation) and *act* on it (resolve a Locator's fallback chain, click, type, read,
 * check a condition). Discovery and replay both run against this interface.
 *
 * The web implementation uses Playwright, but nothing above this interface knows that.
 * A `DesktopDriver` backed by an OS accessibility API would implement the same contract:
 * `snapshot()` yields role/name/text (native to a11y trees), and Locator strategies of
 * kind role/label/text carry over directly (css/testid/nth simply wouldn't be emitted).
 */
import type { Checkpoint, Locator } from "../types/artifact.js";

/** One interactive/readable element, discovered during perception. */
export interface ElementDescriptor {
  ref: string; // ephemeral perception handle (NEVER persisted into an artifact)
  kind: "interactive" | "readable"; // interactive = actable; readable = value/status text
  role: string; // accessibility role (button, link, textbox, combobox, ...)
  name: string; // accessible name (for readable: its nearby label, not its value)
  tag: string;
  type?: string;
  text?: string;
  attrs: {
    id?: string;
    nameAttr?: string;
    placeholder?: string;
    href?: string;
    value?: string;
    ariaLabel?: string;
    labelText?: string;
  };
}

/** A perception snapshot the agent reasons over. Text-first; screenshot is supplementary. */
export interface Observation {
  url: string;
  title: string;
  /** Interactive controls the agent may act on, each with a ref. */
  elements: ElementDescriptor[];
  /** Rendered readable context (headings, alerts, table label/value rows). */
  readText: string;
  /** Names/urls of child frames present (legacy frameset awareness). */
  frames: string[];
  screenshotPath?: string;
}

export interface ResolveResult {
  ok: boolean;
  strategyIndex?: number; // which fallback-chain entry matched
  matchCount?: number;
  error?: string;
}

export interface CheckpointResult {
  ok: boolean;
  observed: string;
}

export interface ActionResult {
  ok: boolean;
  /** The element descriptor acted upon (used by the recorder to synthesize a Locator). */
  element?: ElementDescriptor;
  error?: string;
}

export interface SurfaceDriver {
  start(): Promise<void>;
  close(): Promise<void>;

  navigate(url: string): Promise<void>;
  /** Perceive current state. */
  snapshot(opts?: { screenshot?: boolean; screenshotPath?: string }): Promise<Observation>;

  // --- Discovery-time actions: operate by perception ref ---
  clickRef(ref: string): Promise<ActionResult>;
  typeRef(ref: string, text: string): Promise<ActionResult>;
  selectRef(ref: string, value: string): Promise<ActionResult>;
  readRef(ref: string, from: "text" | "value" | "attr", attr?: string): Promise<ActionResult & { value?: string }>;

  // --- Replay-time actions: operate by durable Locator (fallback chain) ---
  resolve(locator: Locator): Promise<ResolveResult>;
  clickLocator(locator: Locator): Promise<ResolveResult>;
  typeLocator(locator: Locator, text: string): Promise<ResolveResult>;
  selectLocator(locator: Locator, value: string): Promise<ResolveResult>;
  readLocator(locator: Locator, from: "text" | "value" | "attr", attr?: string): Promise<{ ok: boolean; value?: string; error?: string }>;

  // --- Conditions / waits / dialogs ---
  evaluateCheckpoint(cp: Checkpoint): Promise<CheckpointResult>;
  waitFor(opts: { until: string; selector?: Locator; text?: string; timeoutMs: number }): Promise<boolean>;
  dismissDialogIfPresent(): Promise<boolean>;

  screenshot(path: string): Promise<void>;
  currentUrl(): string;
}
