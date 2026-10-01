import { describe, expect, it } from 'vitest';
import { devRendererUrl, isAppPageUrl } from './renderer_url';

describe('devRendererUrl', () => {
  it('uses the dev server URL only in development', () => {
    expect(devRendererUrl(false, { ELECTRON_RENDERER_URL: 'http://localhost:5173' })).toBe('http://localhost:5173');
    expect(devRendererUrl(false, {})).toBeNull();
  });

  it('ignores it in a packaged app', () => {
    expect(devRendererUrl(true, { ELECTRON_RENDERER_URL: 'https://evil.example' })).toBeNull();
  });
});

describe('isAppPageUrl', () => {
  const built = 'file:///C:/Program%20Files/Patch/resources/app.asar/out/renderer/index.html';

  it('accepts the built app page in a packaged app', () => {
    expect(isAppPageUrl(built, true, {})).toBe(true);
    expect(isAppPageUrl('file:///home/me/patch/out/renderer/index.html', true, {})).toBe(true);
  });

  it('accepts the dev server only in development', () => {
    const env = { ELECTRON_RENDERER_URL: 'http://localhost:5173' };
    expect(isAppPageUrl('http://localhost:5173/', false, env)).toBe(true);
    expect(isAppPageUrl('http://localhost:5173/', true, env)).toBe(false);
  });

  it('rejects other pages, other files and garbage', () => {
    expect(isAppPageUrl('https://evil.example/renderer/index.html', true, {})).toBe(false);
    expect(isAppPageUrl('file:///C:/Users/me/Downloads/evil.html', true, {})).toBe(false);
    expect(isAppPageUrl('about:blank', true, {})).toBe(false);
    expect(isAppPageUrl('', true, {})).toBe(false);
  });
});
