import { describe, expect, it } from 'vitest';
import { dayGroup, relativeTime } from './sidebar';

describe('chat list labels', () => {
  const now = new Date(2026, 9, 1, 15, 0);
  const at = (days: number, hours = 0, minutes = 0) => new Date(2026, 9, 1 - days, 15 - hours, -minutes).toISOString();

  it('groups chats by calendar day', () => {
    expect(dayGroup(at(0, 14), now)).toBe('Today');
    expect(dayGroup(new Date(2026, 8, 30, 23, 59).toISOString(), now)).toBe('Yesterday');
    expect(dayGroup(at(3), now)).toBe('Previous 7 days');
    expect(dayGroup(at(7), now)).toBe('Older');
  });

  it('says how long ago a chat was updated', () => {
    expect(relativeTime(at(0), now)).toBe('just now');
    expect(relativeTime(at(0, 0, 10), now)).toBe('10m ago');
    expect(relativeTime(at(0, 5), now)).toBe('5h ago');
    expect(relativeTime(at(0, 22), now)).toBe('22h ago');
    expect(relativeTime(at(1, 2), now)).toBe('Yesterday');
    expect(relativeTime(at(2), now)).toBe(new Date(at(2)).toLocaleDateString());
  });
});
