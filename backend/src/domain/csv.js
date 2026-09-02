/**
 * A tiny RFC-4180-shaped CSV serializer — deliberately not a dependency: the
 * assignment's own guidance is not to add a library for a serializer this
 * small, and the escaping rule is one `if`.
 *
 * A field is quoted only when it contains a comma, a double quote, or a line
 * break; an embedded double quote is doubled, per RFC 4180. Rows are joined
 * with CRLF, including after the final row, matching the RFC's recommended
 * line ending.
 */

export function escapeCsvField(value) {
  const str = value === null || value === undefined ? '' : String(value);
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
