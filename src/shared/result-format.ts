export function cellText(value: unknown): string {
  if (value === null) return 'NULL';
  if (value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export function serializeRows(
  columns: string[],
  rows: Record<string, unknown>[],
  format: 'csv' | 'json' | 'tsv',
): string {
  if (format === 'json')
    return JSON.stringify(
      rows.map((row) => Object.fromEntries(columns.map((name) => [name, row[name]]))),
      null,
      2,
    );
  const separator = format === 'csv' ? ',' : '\t';
  const quote = (value: unknown) => {
    if (value == null) return '';
    const text = cellText(value);
    // Quote strings even when empty, keeping their representation distinct from NULL.
    return typeof value === 'string' || /["\r\n,\t]/.test(text)
      ? '"' + text.replaceAll('"', '""') + '"'
      : text;
  };
  return [
    columns.map(quote).join(separator),
    ...rows.map((row) => columns.map((name) => quote(row[name])).join(separator)),
  ].join('\r\n');
}

// Add whitespace without reserializing numbers, preserving JSON decimal/BIGINT literals.
export function prettyJson(text: string): string | undefined {
  if (text.length > 1024 * 1024) return undefined;
  try {
    JSON.parse(text);
  } catch {
    return undefined;
  }
  let result = '',
    depth = 0,
    quoted = false,
    escaped = false;
  const indent = () => '\n' + '  '.repeat(depth);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      result += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') {
      quoted = true;
      result += c;
    } else if (/\s/.test(c)) continue;
    else if (c === '{' || c === '[') {
      result += c;
      depth++;
      if (depth > 64) return undefined;
      let next = i + 1;
      while (next < text.length && /\s/.test(text[next])) next++;
      if (text[next] !== '}' && text[next] !== ']') result += indent();
    } else if (c === '}' || c === ']') {
      depth--;
      let previous = i - 1;
      while (previous >= 0 && /\s/.test(text[previous])) previous--;
      if (text[previous] !== '{' && text[previous] !== '[') result += indent();
      result += c;
    } else if (c === ',') result += c + indent();
    else if (c === ':') result += ': ';
    else result += c;
  }
  return result;
}
