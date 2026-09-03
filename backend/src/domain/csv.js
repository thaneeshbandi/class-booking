/**
 * A tiny RFC-4180-shaped CSV serializer — deliberately not a dependency: the
 * assignment's own guidance is not to add a library for a serializer this
 * small, and the escaping rule is one `if`.
 *
 * A field is quoted only when it contains a comma, a double quote, or a line
 * break; an embedded double quote is doubled, per RFC 4180. Rows are joined
 * with CRLF, including after the final row, matching the RFC's recommended
 * line ending.
 *
 * A field is also neutralized against CSV/formula injection: the attendance
 * export includes a staff-entered member name, free text an attacker could
 * set to something like `=cmd|'/ccalc'!A1`, which Excel/Sheets/LibreOffice
 * would offer to execute as a formula the moment the file is opened — not a
 * server-side vulnerability, but a real risk to whoever opens the export.
 * The standard mitigation (OWASP) is applied: a field starting with `=`,
 * `+`, `-`, or `@` gets a leading apostrophe, which every spreadsheet
 * application treats as "this cell is text," and which a plain CSV/RFC 4180
 * reader sees as nothing more than an ordinary leading character in the
 * field's own text content.
 */
const FORMULA_TRIGGER = /^[=+\-@]/;

export function escapeCsvField(value) {
  let str = value === null || value === undefined ? '' : String(value);
  if (FORMULA_TRIGGER.test(str)) {
    str = `'${str}`;
  }
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function toCsvRow(fields) {
  return fields.map(escapeCsvField).join(',');
}

/** `rows` is an array of field arrays; `header` is the first row's fields. */
export function toCsv(header, rows) {
  const lines = [toCsvRow(header), ...rows.map(toCsvRow)];
  return `${lines.join('\r\n')}\r\n`;
}
