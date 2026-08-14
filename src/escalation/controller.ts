/**
 * SessionController — makes "who is in control of the live session" explicit and enforced.
 *
 * The automation holds control by default. To hand off, it PAUSES (ceding control to a
 * human) and blocks; the human operates the *same* browser session; on RESUME control
 * returns to the automation. Any attempt by the automation to act while control is held by
 * a human is a programming error (guarded here), which is what keeps the transfer real
 * rather than two actors racing on one session.
 */
import type { Controller } from "./types.js";

export class SessionController {
  private controller: Controller = "agent";
  private onChange?: (c: Controller) => void;

  constructor(onChange?: (c: Controller) => void) {
    this.onChange = onChange;
  }

  who(): Controller {
    return this.controller;
  }

  /** Cede control to the human (called just before raising an intervention). */
  cedeToHuman() {
    this.controller = "human";
    this.onChange?.("human");
  }

  /** Reclaim control (called after the human signals resume). */
  reclaim() {
    this.controller = "agent";
    this.onChange?.("agent");
  }

  /** Guard: automation actions must only run while the agent holds control. */
  assertAgentControls() {
    if (this.controller !== "agent") {
      throw new Error("automation attempted to act while a human holds control of the session");
    }
  }
}
