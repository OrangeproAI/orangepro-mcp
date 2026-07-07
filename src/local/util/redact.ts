/**
 * Secret redaction for any text that may surface in local reports or quote
 * provenance. Privacy default is metadata-only; even when a source excerpt is
 * read in-process for generation, obvious secrets are scrubbed first.
 */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<redacted:private-key>"],
  [/sk-ant-[A-Za-z0-9_-]{16,}/g, "<redacted:anthropic-key>"],
  [/sk-[A-Za-z0-9]{20,}/g, "<redacted:openai-key>"],
  [/ghp_[A-Za-z0-9]{20,}/g, "<redacted:github-token>"],
  [/gho_[A-Za-z0-9]{20,}/g, "<redacted:github-token>"],
  [/AKIA[0-9A-Z]{16}/g, "<redacted:aws-access-key>"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, "<redacted:slack-token>"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "<redacted:jwt>"],
  [/\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']?[^\s"']{8,}/gi, "<redacted:credential>"]
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function redactSecretsPreservingLineCount(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, (match) => {
      const newlineCount = match.match(/\r\n|\n|\r/g)?.length ?? 0;
      return `${replacement}${"\n".repeat(newlineCount)}`;
    });
  }
  return out;
}

export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some(([pattern]) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}
