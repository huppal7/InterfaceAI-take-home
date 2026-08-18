/**
 * Playwright-backed SurfaceDriver for web (and legacy web) surfaces.
 *
 * Nothing above the SurfaceDriver interface depends on Playwright — this file is the only
 * place the browser mechanism lives. A DesktopDriver would sit beside it, same contract.
 */
import { chromium, type Browser, type BrowserContext, type Page, type Locator as PwLocator } from "playwright";
import type {
  ActionResult,
  CheckpointResult,
  ElementDescriptor,
  Observation,
  ResolveResult,
  SurfaceDriver,
} from "./types.js";
import type { Checkpoint, Locator, LocatorStrategy } from "../types/artifact.js";
import { snapshotScript } from "./snapshot.js";

export interface WebDriverOptions {
  headless?: boolean;
  slowMo?: number;
}

export class WebDriver implements SurfaceDriver {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private lastElements = new Map<string, ElementDescriptor>();

  constructor(private opts: WebDriverOptions = {}) {}

  async start(): Promise<void> {
    this.browser = await chromium.launch({ headless: this.opts.headless ?? true, slowMo: this.opts.slowMo ?? 0 });
    this.context = await this.browser.newContext();
    this.page = await this.context.newPage();
    // Auto-dismiss native dialogs so an unexpected browser confirm() never wedges a run;
    // the driver records that one appeared for evidence.
    this.page.on("dialog", (d) => d.dismiss().catch(() => {}));
  }

  async close(): Promise<void> {
    await this.browser?.close();
  }

  private p(): Page {
    if (!this.page) throw new Error("driver not started");
    return this.page;
  }

  async navigate(url: string): Promise<void> {
    await this.p().goto(url, { waitUntil: "domcontentloaded" });
  }

  currentUrl(): string {
    return this.page?.url() ?? "";
  }

  async screenshot(path: string): Promise<void> {
    await this.p().screenshot({ path, fullPage: true });
  }

  async snapshot(opts: { screenshot?: boolean; screenshotPath?: string } = {}): Promise<Observation> {
    const page = this.p();
    // Evaluate as a string with a `__name` shim in scope: the TS runner (esbuild/tsx)
    // rewrites named functions to `__name(fn, "name")`, but that helper doesn't exist in
    // the browser. Defining it in the eval scope makes the serialized function run cleanly.
    const raw = (await page.evaluate(
      `(() => { const __name = (f) => f; return (${snapshotScript.toString()})(); })()`
    )) as {
      elements: ElementDescriptor[];
      readText: string;
      frames: string[];
    };
    this.lastElements = new Map(raw.elements.map((e) => [e.ref, e]));
    let screenshotPath: string | undefined;
    if (opts.screenshot && opts.screenshotPath) {
      await this.screenshot(opts.screenshotPath);
      screenshotPath = opts.screenshotPath;
    }
    return {
      url: page.url(),
      title: await page.title(),
      elements: raw.elements,
      readText: raw.readText,
      frames: raw.frames,
      screenshotPath,
    };
  }

  // --- discovery actions (by ref) ---
  private byRef(ref: string): PwLocator {
    return this.p().locator(`[data-cu-ref="${ref}"]`);
  }

  async clickRef(ref: string): Promise<ActionResult> {
    const el = this.lastElements.get(ref);
    if (!el) return { ok: false, error: `unknown ref ${ref}` };
    try {
      await this.byRef(ref).first().click({ timeout: 8000 });
      return { ok: true, element: el };
    } catch (e) {
      return { ok: false, element: el, error: String(e) };
    }
  }

  async typeRef(ref: string, text: string): Promise<ActionResult> {
    const el = this.lastElements.get(ref);
    if (!el) return { ok: false, error: `unknown ref ${ref}` };
    try {
      await this.byRef(ref).first().fill(text, { timeout: 8000 });
      return { ok: true, element: el };
    } catch (e) {
      return { ok: false, element: el, error: String(e) };
    }
  }

  async selectRef(ref: string, value: string): Promise<ActionResult> {
    const el = this.lastElements.get(ref);
    if (!el) return { ok: false, error: `unknown ref ${ref}` };
    try {
      await this.byRef(ref).first().selectOption(value, { timeout: 8000 });
      return { ok: true, element: el };
    } catch (e) {
      return { ok: false, element: el, error: String(e) };
    }
  }

  async readRef(ref: string, from: "text" | "value" | "attr", attr?: string): Promise<ActionResult & { value?: string }> {
    const el = this.lastElements.get(ref);
    if (!el) return { ok: false, error: `unknown ref ${ref}` };
    try {
      const loc = this.byRef(ref).first();
      let value: string | null = null;
      if (from === "text") value = await loc.textContent();
      else if (from === "value") value = await loc.inputValue();
      else value = await loc.getAttribute(attr ?? "");
      return { ok: true, element: el, value: (value ?? "").trim() };
    } catch (e) {
      return { ok: false, element: el, error: String(e) };
    }
  }

  // --- replay actions (by durable Locator + fallback chain) ---
  private locatorForStrategy(s: LocatorStrategy, frameScope?: Locator["framePath"]): PwLocator {
    // frameScope handling: descend into frames if a framePath is provided.
    let scope: Page | ReturnType<Page["frameLocator"]> = this.p();
    if (frameScope && frameScope.length) {
      for (const f of frameScope) {
        // Match frame by name or url fragment.
        scope = (scope as any).frameLocator(`iframe[name="${f}"], iframe[src*="${f}"]`);
      }
    }
    const anyScope = scope as any;
    switch (s.kind) {
      case "role":
        return anyScope.getByRole(s.role as any, s.name ? { name: s.name, exact: s.exact } : undefined);
      case "label":
        return anyScope.getByLabel(s.value, { exact: s.exact });
      case "placeholder":
        return anyScope.getByPlaceholder(s.value);
      case "text":
        return anyScope.getByText(s.value, { exact: s.exact });
      case "altText":
        return anyScope.getByAltText(s.value);
      case "testid":
        return anyScope.getByTestId(s.value);
      case "css":
        return anyScope.locator(s.value);
      case "nth":
        return anyScope.locator(s.within).nth(s.index);
    }
  }

  async resolve(locator: Locator): Promise<ResolveResult> {
    for (let i = 0; i < locator.strategies.length; i++) {
      try {
        const loc = this.locatorForStrategy(locator.strategies[i], locator.framePath);
        const count = await loc.count();
        if (count >= 1) return { ok: true, strategyIndex: i, matchCount: count };
      } catch {
        /* try next strategy */
      }
    }
    return { ok: false, error: `no strategy resolved for "${locator.description}"` };
  }

  private async actResolved<T>(
    locator: Locator,
    fn: (loc: PwLocator) => Promise<T>
  ): Promise<ResolveResult> {
    for (let i = 0; i < locator.strategies.length; i++) {
      try {
        const loc = this.locatorForStrategy(locator.strategies[i], locator.framePath);
        const count = await loc.count();
        if (count >= 1) {
          await fn(loc.first());
          return { ok: true, strategyIndex: i, matchCount: count };
        }
      } catch (e) {
        if (i === locator.strategies.length - 1) return { ok: false, error: String(e) };
      }
    }
    return { ok: false, error: `no strategy resolved for "${locator.description}"` };
  }

  clickLocator(locator: Locator): Promise<ResolveResult> {
    return this.actResolved(locator, (loc) => loc.click({ timeout: 8000 }));
  }
  typeLocator(locator: Locator, text: string): Promise<ResolveResult> {
    return this.actResolved(locator, (loc) => loc.fill(text, { timeout: 8000 }));
  }
  selectLocator(locator: Locator, value: string): Promise<ResolveResult> {
    return this.actResolved(locator, (loc) => loc.selectOption(value, { timeout: 8000 }));
  }

  async readLocator(
    locator: Locator,
    from: "text" | "value" | "attr",
    attr?: string
  ): Promise<{ ok: boolean; value?: string; error?: string }> {
    for (let i = 0; i < locator.strategies.length; i++) {
      try {
        const loc = this.locatorForStrategy(locator.strategies[i], locator.framePath).first();
        if ((await loc.count()) < 1) continue;
        let value: string | null = null;
        if (from === "text") value = (await loc.textContent()) ?? "";
        else if (from === "value") value = await loc.inputValue();
        else if (from === "attr") value = await loc.getAttribute(attr ?? "");
        return { ok: true, value: (value ?? "").trim() };
      } catch {
        /* next */
      }
    }
    return { ok: false, error: `could not read "${locator.description}"` };
  }

  async evaluateCheckpoint(cp: Checkpoint): Promise<CheckpointResult> {
    const page = this.p();
    switch (cp.type) {
      case "urlMatches": {
        const url = page.url();
        let pathAndQuery = url;
        try {
          const u = new URL(url);
          pathAndQuery = `${u.pathname}${u.search}`;
        } catch {
          /* keep full url */
        }
        const re = new RegExp(cp.pattern);
        return { ok: re.test(pathAndQuery) || re.test(url), observed: url };
      }
      case "textPresent": {
        if (cp.within) {
          const r = await this.readLocator(cp.within, "text");
          const present = (r.value ?? "").includes(cp.text);
          return { ok: present, observed: r.value ?? "(unresolved)" };
        }
        const body = (await page.textContent("body")) ?? "";
        return { ok: body.includes(cp.text), observed: body.includes(cp.text) ? `found "${cp.text}"` : `missing "${cp.text}"` };
      }
      case "textAbsent": {
        const body = (await page.textContent("body")) ?? "";
        return { ok: !body.includes(cp.text), observed: body.includes(cp.text) ? `found "${cp.text}"` : "absent" };
      }
      case "elementVisible": {
        const r = await this.resolve(cp.locator);
        return { ok: r.ok, observed: r.ok ? `visible (strategy ${r.strategyIndex})` : "not found" };
      }
      case "elementCount": {
        const loc = this.locatorForStrategy(cp.locator.strategies[0], cp.locator.framePath);
        const n = await loc.count();
        return { ok: n === cp.count, observed: `count=${n}` };
      }
    }
  }

  async waitFor(opts: { until: string; selector?: Locator; text?: string; timeoutMs: number }): Promise<boolean> {
    const page = this.p();
    try {
      if (opts.until === "load" || opts.until === "networkidle") {
        await page.waitForLoadState(opts.until === "networkidle" ? "networkidle" : "load", { timeout: opts.timeoutMs });
        return true;
      }
      if (opts.until === "selectorVisible" && opts.selector) {
        const loc = this.locatorForStrategy(opts.selector.strategies[0], opts.selector.framePath);
        await loc.first().waitFor({ state: "visible", timeout: opts.timeoutMs });
        return true;
      }
      if (opts.until === "textPresent" && opts.text) {
        await page.getByText(opts.text).first().waitFor({ state: "visible", timeout: opts.timeoutMs });
        return true;
      }
      if (opts.until === "timeout") {
        await page.waitForTimeout(opts.timeoutMs);
        return true;
      }
    } catch {
      return false;
    }
    return true;
  }

  async dismissDialogIfPresent(): Promise<boolean> {
    const page = this.p();
    const dialog = page.locator('[role="dialog"]');
    if ((await dialog.count()) >= 1) {
      // Click a plausible dismiss control inside the dialog.
      const btn = dialog.getByRole("button").first();
      if ((await btn.count()) >= 1) {
        await btn.click({ timeout: 5000 }).catch(() => {});
        return true;
      }
    }
    return false;
  }
}
