/**
 * What a variable puts into a verify card's prompt. A ticked checkbox adds
 * its text and an unticked one adds nothing; an image variable adds its
 * description. The cards used to store the words "off", "on" or "true"
 * instead, and those reached the paid prompt verbatim (Kev, 2026-10-06).
 */
export interface SnapshotVariable {
  name: string;
  type: string;
  defaultValue: string | boolean;
  description: string;
}

/** The text of a checkbox or image variable, or null for a text variable, whose value the caller picks. */
export function fixedValue(v: SnapshotVariable): string | null {
  if (v.type === "checkbox") return v.defaultValue ? v.description || "" : "";
  if (v.type === "image") return v.description || "";
  return null;
}

/** A variable's value for a new card: its fixed text, else its own value, else its name. */
export function snapshotValue(v: SnapshotVariable): string {
  return fixedValue(v) ?? ((typeof v.defaultValue === "string" && v.defaultValue) || v.name);
}
