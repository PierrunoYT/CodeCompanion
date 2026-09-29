import { describe, expect, it } from 'vitest';
import { isNetworkUrlAllowed } from './allowed_network_hosts';

describe('isNetworkUrlAllowed', () => {
  const allowed = 'Example.COM\nlocalhost\n';

  it('matches exact URL hostnames case-insensitively', () => {
    expect(isNetworkUrlAllowed('https://example.com/path', allowed)).toBe(true);
    expect(isNetworkUrlAllowed('HTTP://EXAMPLE.COM:8080/path', allowed)).toBe(true);
  });

  it('rejects suffix, subdomain, userinfo and non-http tricks', () => {
    expect(isNetworkUrlAllowed('https://example.com.evil.test', allowed)).toBe(false);
    expect(isNetworkUrlAllowed('https://sub.example.com', allowed)).toBe(false);
    expect(isNetworkUrlAllowed('https://example.com@evil.test', allowed)).toBe(false);
    expect(isNetworkUrlAllowed('file:///example.com', allowed)).toBe(false);
    expect(isNetworkUrlAllowed('not a url', allowed)).toBe(false);
  });

  it('allows nothing when the setting is missing or empty', () => {
    expect(isNetworkUrlAllowed('https://example.com', '')).toBe(false);
    expect(isNetworkUrlAllowed('https://example.com', undefined as unknown as string)).toBe(false);
  });
});
