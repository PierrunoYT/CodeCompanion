// Secrets that show up in tool results (a `cat .env`, a read of a key file, a command that prints a token) are
// replaced before the text reaches the model, the transcript or the saved chat. The patterns are well-known token
// formats plus quoted or .env-style values of credential-named variables; ordinary code such as
// `token = getToken()` is left alone.

export const REDACTION_MARK = '[REDACTED:_____]';

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  // password = "hunter2hunter2", "api_key": "…", client_secret: '…' (quoted values only)
  /(?<=\b[\w-]*(?:password|passwd|secret|token|api[_-]?key)[\w-]*["']?\s*[=:]\s*["'])[^\s"']{8,}(?=["'])/gi,
  // .env style: DB_PASSWORD=value, STRIPE_SECRET_KEY=value (whole line, upper case names)
  /(?<=^[ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*[ \t]*=[ \t]*["']?)[^\s"'$(){}]{8,}/gm,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTION_MARK);
  return out;
}

export function containsRedaction(text: string): boolean {
  return text.includes(REDACTION_MARK);
}
