/**
 * In-page perception walker. Runs in the browser (via page.evaluate) and returns an
 * accessibility-first description of the current document.
 *
 * It tags interactive/readable elements with an EPHEMERAL `data-cu-ref` attribute so the
 * agent can act on them by ref during discovery. That attribute is perception-only
 * instrumentation — it is stripped/ignored when synthesizing durable Locators, so the
 * recorded artifact never depends on it (the app itself has no test IDs).
 */

/** Serialized to run in the page. Returns { elements, readText, frames }. */
export function snapshotScript() {
  const INTERACTIVE = "a,button,input,select,textarea,summary,[role=button],[role=link]";

  function isVisible(el: Element): boolean {
    const he = el as HTMLElement;
    if (he.hidden) return false;
    const style = window.getComputedStyle(he);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = he.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function roleOf(el: Element): string {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "submit" || t === "button") return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "password" || t === "text" || t === "email" || t === "search") return "textbox";
      return "textbox";
    }
    return tag;
  }

  function labelFor(el: Element): string | undefined {
    const id = el.getAttribute("id");
    if (id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (lbl && lbl.textContent) return lbl.textContent.trim();
    }
    const wrap = el.closest("label");
    if (wrap && wrap.textContent) return wrap.textContent.trim();
    return undefined;
  }

  function accessibleName(el: Element): string {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    const lbl = labelFor(el);
    if (lbl) return lbl;
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "submit" || t === "button") return (el.getAttribute("value") || "").trim();
      return (el.getAttribute("placeholder") || "").trim();
    }
    return (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
  }

  // Label for a readable value element: the <th> in its own table row, else its id.
  function readableLabel(el: Element): string {
    const row = el.closest("tr");
    const th = row?.querySelector("th");
    if (th && th.textContent) return th.textContent.trim();
    const prevLabel = el.closest("[id]")?.previousElementSibling;
    if (prevLabel && prevLabel.textContent) return prevLabel.textContent.trim();
    return el.getAttribute("id") || "";
  }

  const elements: any[] = [];
  const seen = new Set<Element>();
  let i = 0;
  document.querySelectorAll(INTERACTIVE).forEach((el) => {
    if (!isVisible(el)) return;
    seen.add(el);
    const ref = `e${i++}`;
    el.setAttribute("data-cu-ref", ref);
    elements.push({
      ref,
      kind: "interactive",
      role: roleOf(el),
      name: accessibleName(el),
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || undefined,
      text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80) || undefined,
      attrs: {
        id: el.getAttribute("id") || undefined,
        nameAttr: el.getAttribute("name") || undefined,
        placeholder: el.getAttribute("placeholder") || undefined,
        href: el.getAttribute("href") || undefined,
        value: (el as HTMLInputElement).value || undefined,
        ariaLabel: el.getAttribute("aria-label") || undefined,
        labelText: labelFor(el),
      },
    });
  });

  // Readable value/status elements: id-bearing text and role=status/alert. These carry
  // outputs (balances, confirmation numbers) that the agent may capture via the read tool.
  document.querySelectorAll("[id],[role=status],[role=alert]").forEach((el) => {
    if (seen.has(el)) return;
    if (!isVisible(el)) return;
    const text = (el.textContent || "").trim().replace(/\s+/g, " ");
    if (!text) return;
    seen.add(el);
    const ref = `r${i++}`;
    el.setAttribute("data-cu-ref", ref);
    elements.push({
      ref,
      kind: "readable",
      role: el.getAttribute("role") || "text",
      name: readableLabel(el),
      tag: el.tagName.toLowerCase(),
      text: text.slice(0, 80),
      attrs: { id: el.getAttribute("id") || undefined, ariaLabel: el.getAttribute("aria-label") || undefined },
    });
  });

  // Readable context: headings, alerts/status, and table label/value rows.
  const lines: string[] = [];
  document.querySelectorAll("h1,h2,h3,h4,[role=alert],[role=status]").forEach((el) => {
    const t = (el.textContent || "").trim().replace(/\s+/g, " ");
    if (t) lines.push(t);
  });
  document.querySelectorAll("table tr").forEach((tr) => {
    const cells = Array.from(tr.querySelectorAll("th,td")).map((c) => (c.textContent || "").trim().replace(/\s+/g, " "));
    const joined = cells.filter(Boolean).join(" | ");
    if (joined) lines.push(joined);
  });

  const frames = Array.from(document.querySelectorAll("iframe,frame")).map(
    (f) => f.getAttribute("name") || f.getAttribute("src") || "(frame)"
  );

  return { elements, readText: lines.join("\n"), frames };
}
