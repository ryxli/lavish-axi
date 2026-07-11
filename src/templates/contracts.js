export const TEMPLATE_CONTRACTS = Object.freeze({
  decision: ["hero", "verdict", "callout", "decision-form", "actions"],
  plan: ["hero", "timeline", "verdict", "cards", "callout", "actions"],
  comparison: ["hero", "comparison-table", "metric-grid", "verdict", "decision-form"],
  report: ["hero", "metric-grid", "verdict", "cards", "code-block"],
});

export const WHITEBOARD_TEMPLATE_CONTRACTS = Object.freeze({
  architecture: ["hero", "timeline", "code-block", "callout", "actions"],
});

export const TEMPLATE_METADATA = Object.freeze({
  decision: Object.freeze({ title: "Decision", treatment: "reading-room" }),
  plan: Object.freeze({ title: "Plan", treatment: "causal-diagram" }),
  comparison: Object.freeze({ title: "Comparison", treatment: "operations-desk" }),
  report: Object.freeze({ title: "Report", treatment: "operations-desk" }),
  architecture: Object.freeze({ title: "Architecture", treatment: "causal-diagram" }),
});

export const DEFAULT_TEMPLATE = "decision";

export function contractsForEnvironment(enableWhiteboard = process.env.LAVISH_AXI_ENABLE_WHITEBOARD_EDITING === "1") {
  return enableWhiteboard ? { ...TEMPLATE_CONTRACTS, ...WHITEBOARD_TEMPLATE_CONTRACTS } : { ...TEMPLATE_CONTRACTS };
}

export function isWhiteboardTemplate(template) {
  return Object.hasOwn(WHITEBOARD_TEMPLATE_CONTRACTS, template);
}
