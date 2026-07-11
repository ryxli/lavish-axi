export const LAYOUT_AUDIT_OVERFLOW_EPSILON = 1;
export const LAYOUT_AUDIT_ERROR_OVERFLOW_PX = 4;
export const LAYOUT_WARNING_SEVERITIES = Object.freeze({ warning: "warning", error: "error" });

export function severityForOverflow(overflowPx) {
  return Number(overflowPx) > LAYOUT_AUDIT_ERROR_OVERFLOW_PX
    ? LAYOUT_WARNING_SEVERITIES.error
    : LAYOUT_WARNING_SEVERITIES.warning;
}

export function hasBlockingLayoutWarnings(warnings) {
  return Array.isArray(warnings) && warnings.some((warning) => warning?.severity === LAYOUT_WARNING_SEVERITIES.error);
}
