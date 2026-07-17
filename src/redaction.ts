const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
];

export function redactSecrets(value: string): string {
  const redacted = SECRET_PATTERNS.reduce((result, pattern) => result.replace(pattern, "[REDACTED]"), value);
  return redacted.replace(/([?&](?:access_token|token)=)[^&\s]+/gi, "$1[REDACTED]");
}
