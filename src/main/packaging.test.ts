import { readFileSync } from 'node:fs';
import { DOMParser } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { build } from '../../package.json';

describe('macOS packaging security', () => {
  it('keeps hardened runtime enabled with only the JIT entitlement for the app and its helpers', () => {
    expect(build.mac.hardenedRuntime).toBe(true);
    for (const path of [build.mac.entitlements, build.mac.entitlementsInherit]) {
      const plist = new DOMParser().parseFromString(readFileSync(path, 'utf8'), 'text/xml');
      const entries = Array.from<Element>(plist.querySelector('plist > dict')!.children);
      expect(entries.map((entry) => [entry.tagName, entry.textContent])).toEqual([
        ['key', 'com.apple.security.cs.allow-jit'],
        ['true', ''],
      ]);
    }
  });
});
