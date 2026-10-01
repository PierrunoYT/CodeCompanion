import { describe, expect, it } from 'vitest';
import { devRendererUrl } from './renderer_url';

describe('devRendererUrl', () => {
  it('uses the dev server URL only in development', () => {
    expect(devRendererUrl(false, { ELECTRON_RENDERER_URL: 'http://localhost:5173' })).toBe('http://localhost:5173');
    expect(devRendererUrl(false, {})).toBeNull();
  });

  it('ignores it in a packaged app', () => {
    expect(devRendererUrl(true, { ELECTRON_RENDERER_URL: 'https://evil.example' })).toBeNull();
  });
});
