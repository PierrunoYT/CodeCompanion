import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { BrowserService } from './browser';

class FakeGuest extends EventEmitter {
  destroyed = false;
  url = 'about:blank';
  loadURL = vi.fn(async (url: string) => {
    this.url = url;
    this.emit('did-navigate', {}, url, 200);
    this.emit('console-message', { level: 'error', message: 'boom' });
  });
  isDestroyed = () => this.destroyed;
  getURL = () => this.url;
  getTitle = () => 'Title';
  capturePage = vi.fn();
}

function attach(service: BrowserService, guest: FakeGuest): void {
  service.attach(guest as unknown as WebContents);
}

describe('BrowserService', () => {
  it('reports availability and forgets a destroyed guest', () => {
    const service = new BrowserService(() => {});
    const guest = new FakeGuest();
    expect(service.available).toBe(false);
    attach(service, guest);
    expect(service.available).toBe(true);
    guest.destroyed = true;
    guest.emit('destroyed');
    expect(service.available).toBe(false);
  });

  it('opens a page and returns its status, title and console output', async () => {
    const show = vi.fn();
    const service = new BrowserService(show);
    const guest = new FakeGuest();
    attach(service, guest);

    const result = await service.open('http://localhost/test', new AbortController().signal);
    expect(show).toHaveBeenCalled();
    expect(result).toEqual({
      url: 'http://localhost/test',
      title: 'Title',
      status: 200,
      console: ['[error] boom'],
      error: undefined,
    });
    // The listeners are removed again, so later page output is not collected.
    expect(guest.listenerCount('console-message')).toBe(0);
    expect(guest.listenerCount('did-navigate')).toBe(0);
    expect(guest.listenerCount('did-fail-load')).toBe(0);
  });

  it('reports load failures but ignores aborted loads', async () => {
    const service = new BrowserService(() => {});
    const guest = new FakeGuest();
    guest.loadURL.mockImplementation(async () => {
      guest.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'http://x', true);
      guest.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'http://x', true);
      guest.emit('did-fail-load', {}, -2, 'subframe error', 'http://x', false);
    });
    attach(service, guest);
    const result = await service.open('http://x', new AbortController().signal);
    expect(result.error).toBe('ERR_NAME_NOT_RESOLVED (-105)');
  });

  it('blocks redirects and later navigations outside the approved policy', async () => {
    const service = new BrowserService(() => {});
    const guest = new FakeGuest();
    attach(service, guest);
    const result = await service.open('https://allowed.test/start', new AbortController().signal, (url) =>
      url.startsWith('https://allowed.test/'),
    );
    const redirectEvent = { preventDefault: vi.fn() };
    guest.emit('will-redirect', redirectEvent, 'https://evil.test/redirect');
    expect(redirectEvent.preventDefault).toHaveBeenCalled();
    const laterEvent = { preventDefault: vi.fn() };
    guest.emit('will-navigate', laterEvent, 'https://evil.test/later');
    expect(laterEvent.preventDefault).toHaveBeenCalled();
    expect(result.error).toBeUndefined();
  });

  it('reports the error when loadURL rejects', async () => {
    const service = new BrowserService(() => {});
    const guest = new FakeGuest();
    guest.loadURL.mockRejectedValue(new Error('load failed'));
    attach(service, guest);
    const result = await service.open('http://x', new AbortController().signal);
    expect(result.error).toBe('load failed');
  });

  it('stops when the chat is stopped', async () => {
    const service = new BrowserService(() => {});
    const guest = new FakeGuest();
    guest.loadURL.mockImplementation(() => new Promise(() => {}));
    attach(service, guest);
    const controller = new AbortController();
    const pending = service.open('http://slow', controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('Stopped.');
    expect(guest.listenerCount('console-message')).toBe(0);
  });

  it('waits for the panel to attach a page', async () => {
    const service = new BrowserService(() => {});
    const guest = new FakeGuest();
    guest.capturePage.mockResolvedValue({
      getSize: () => ({ width: 100, height: 50 }),
      toPNG: () => Buffer.from('png-bytes'),
    });
    const pending = service.screenshot();
    attach(service, guest);
    expect(await pending).toBe(Buffer.from('png-bytes').toString('base64'));
  });

  it('scales wide screenshots down', async () => {
    const service = new BrowserService(() => {});
    const guest = new FakeGuest();
    const resized = { getSize: () => ({ width: 1280, height: 720 }), toPNG: () => Buffer.from('small') };
    const resize = vi.fn(() => resized);
    guest.capturePage.mockResolvedValue({ getSize: () => ({ width: 2560, height: 1440 }), resize, toPNG: vi.fn() });
    attach(service, guest);
    expect(await service.screenshot()).toBe(Buffer.from('small').toString('base64'));
    expect(resize).toHaveBeenCalledWith({ width: 1280 });
  });

  it('fails when no page is attached in time', async () => {
    vi.useFakeTimers();
    try {
      const service = new BrowserService(() => {});
      const pending = service.screenshot();
      const assertion = expect(pending).rejects.toThrow('The browser panel did not open.');
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
