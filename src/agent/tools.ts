/**
 * Tool surface exposed to the discovery agent. The agent perceives an accessibility-first
 * observation and acts ONLY through these tools — it never sees or manipulates raw DOM,
 * which is what keeps discovery honest about the "no clean DOM" reality and makes the
 * resulting steps recordable as durable, surface-agnostic locators.
 */
import type Anthropic from "@anthropic-ai/sdk";

export const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: "click",
    description:
      "Click a control (button, link) identified by its perception ref. Set risky=true for irreversible or state-changing actions (submitting a transaction, confirming an account creation, posting, deleting).",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "The element ref from the observation, e.g. e3." },
        description: { type: "string", description: "Human-readable purpose, e.g. 'Submit member lookup'." },
        risky: { type: "boolean", description: "True if this action is irreversible/state-changing." },
      },
      required: ["ref", "description"],
    },
  },
  {
    name: "type",
    description:
      "Type text into a field identified by its ref. If the text is a value the caller would supply per invocation (e.g. a member ID), set bindToInput to the input parameter name so the recording is parameterized.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        text: { type: "string", description: "The literal text to type for THIS run." },
        description: { type: "string" },
        bindToInput: { type: "string", description: "Input parameter name to bind this value to (optional)." },
      },
      required: ["ref", "text", "description"],
    },
  },
  {
    name: "select",
    description: "Choose an option in a dropdown identified by its ref.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        value: { type: "string", description: "The option value/label to choose." },
        description: { type: "string" },
        bindToInput: { type: "string", description: "Input parameter name to bind this to (optional)." },
      },
      required: ["ref", "value", "description"],
    },
  },
  {
    name: "read",
    description:
      "Capture a piece of state from the page as a declared OUTPUT of this capability (e.g. a balance). Provide a stable outputName and how to normalize it.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        outputName: { type: "string" },
        from: { type: "string", enum: ["text", "value", "attr"], description: "Where to read from (default text)." },
        attr: { type: "string", description: "Attribute name when from=attr." },
        normalize: { type: "string", enum: ["none", "money", "trim", "digits"], description: "Normalization to apply." },
        description: { type: "string" },
      },
      required: ["ref", "outputName", "description"],
    },
  },
  {
    name: "escalate",
    description: "Request a human operator when you are stuck and cannot safely proceed.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", enum: ["stuck", "unrecoverable"] },
        message: { type: "string", description: "What you need and why you stopped." },
      },
      required: ["reason", "message"],
    },
  },
  {
    name: "finish",
    description:
      "End the run. On success, provide the full capability contract so the flow can be saved as a reusable, typed, parameterized capability. On give_up, explain why.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["success", "give_up"] },
        message: { type: "string" },
        capability: {
          type: "object",
          description: "Required when status=success.",
          properties: {
            id: { type: "string", description: "Stable id, e.g. member.read_savings_balance." },
            name: { type: "string" },
            description: { type: "string" },
            successConditionText: { type: "string", description: "Text that must be present on the page when the goal is achieved." },
            inputs: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  type: { type: "string", enum: ["string", "number", "boolean", "date", "money", "enum"] },
                  required: { type: "boolean" },
                  description: { type: "string" },
                  sensitive: { type: "boolean" },
                  enumValues: { type: "array", items: { type: "string" } },
                  example: { type: "string" },
                },
                required: ["name", "type", "description"],
              },
            },
            outputs: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  type: { type: "string", enum: ["string", "number", "boolean", "date", "money", "enum"] },
                  description: { type: "string" },
                },
                required: ["name", "type", "description"],
              },
            },
          },
          required: ["id", "name", "description", "successConditionText", "inputs", "outputs"],
        },
      },
      required: ["status", "message"],
    },
  },
];
