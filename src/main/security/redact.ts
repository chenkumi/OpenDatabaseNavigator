const secretKey =
  /password|passwd|token|secret|private.?key|credential|authorization|^(pwd|pass|passphrase|api[-_ ]?key|access[-_ ]?key)$/i;
const MIN_SECRET_LENGTH = 4;
export function redact(value: unknown, secrets: string[] = []): unknown {
  if (typeof value === 'string') {
    let text = value
      .replace(/\b(Bearer)\s+[A-Za-z0-9._~+\/-]+/gi, '$1 [REDACTED]')
      .replace(
        /(password|passwd|token|secret|authorization)\s*([=:])\s*('[^']*'|"[^"]*"|[^\s,;]+)/gi,
        '$1$2[REDACTED]',
      );
    text = text
      .replace(
        /\b(IDENTIFIED\s+BY|PASSWORD)\s+((?:E|N)?'(?:''|\\.|[^'\\])*'|"(?:""|\\.|[^"\\])*")/gi,
        '$1 [REDACTED]',
      )
      .replace(/([a-z][a-z0-9+.-]{0,31}:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi, '$1[REDACTED]$2');
    // A one- or two-character password would otherwise rewrite every occurrence of
    // that text in results and logs. Pattern-based redaction above still applies.
    for (const secret of secrets
      .filter((item) => item.length >= MIN_SECRET_LENGTH)
      .sort((a, b) => b.length - a.length))
      text = text.split(secret).join('[REDACTED]');
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        secretKey.test(key) ? '[REDACTED]' : redact(item, secrets),
      ]),
    );
  return value;
}
