/** Preserve data while preventing a spreadsheet from evaluating user-supplied cells. */
export function csvCell(value: unknown): string {
  let normalized = value === undefined || value === null ? '' : Array.isArray(value) ? value.join('|') : String(value);
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(normalized)) normalized = `'${normalized}`;
  return `"${normalized.replace(/"/g, '""')}"`;
}
