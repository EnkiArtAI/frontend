/**
 * What a report can say, as the popup shows it, and how urgent each reason is
 * in the admin queue. The values are the reports_reason_check values;
 * child_safety needs sql-to-run/11. Severity follows the reason, never the
 * reporter.
 */
export const REPORT_REASONS = [
  { value: "child_safety", label: "Involves a minor", severity: "critical" },
  { value: "obscene", label: "Sexual or obscene content", severity: "high" },
  { value: "hate", label: "Hate or harassment", severity: "high" },
  { value: "copyright", label: "Stolen work or copyright", severity: "medium" },
  { value: "impersonation", label: "Impersonation", severity: "medium" },
  { value: "spam", label: "Spam or scam", severity: "low" },
  { value: "other", label: "Something else", severity: "low" },
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number]["value"];

/** What can be reported: a prompt, one image, or a profile (the reports_target_type_check values). */
export const REPORT_TARGETS = ["prompt", "generation", "user"] as const;
export type ReportTarget = (typeof REPORT_TARGETS)[number];
