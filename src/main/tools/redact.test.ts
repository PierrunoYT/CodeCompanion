import { describe, expect, it } from 'vitest';
import { containsRedaction, redactSecrets, REDACTION_MARK } from './redact';

describe('redactSecrets', () => {
  it.each([
    ['AWS key', 'id AKIAIOSFODNN7EXAMPLE end'],
    ['GitHub token', `token ghp_${'a'.repeat(36)}`],
    ['Anthropic key', `key sk-ant-${'x1'.repeat(20)}`],
    ['Slack token', 'xoxb-1234567890-abcdefghij'],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkw.abcdefghij1234567890'],
    ['private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEvQ\nabc\n-----END RSA PRIVATE KEY-----'],
  ])('replaces a %s', (_name, text) => {
    const out = redactSecrets(text);
    expect(containsRedaction(out)).toBe(true);
    expect(out).not.toContain('EXAMPLE');
  });

  it('keeps the surrounding text', () => {
    expect(redactSecrets('before AKIAIOSFODNN7EXAMPLE after')).toBe(`before ${REDACTION_MARK} after`);
  });

  it('redacts quoted credential values and .env lines', () => {
    expect(redactSecrets('const password = "hunter2hunter2";')).toBe(`const password = "${REDACTION_MARK}";`);
    expect(redactSecrets('{"api_key": "abcdefgh12345"}')).toBe(`{"api_key": "${REDACTION_MARK}"}`);
    expect(redactSecrets('A=1\nDB_PASSWORD=supersecret1\nPORT=80')).toBe(`A=1\nDB_PASSWORD=${REDACTION_MARK}\nPORT=80`);
    expect(redactSecrets('export STRIPE_SECRET_KEY="sk_live_abcdefgh"')).toContain(REDACTION_MARK);
  });

  it('leaves ordinary code alone', () => {
    const code = [
      'const token = getAccessToken();',
      'let password: string;',
      'if (token === undefined) return;',
      'const secret = process.env.SECRET_VALUE;',
      'task-management-and-other-long-words',
      'NODE_ENV=production',
    ].join('\n');
    expect(redactSecrets(code)).toBe(code);
  });
});
