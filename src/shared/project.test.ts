import { describe, expect, it } from 'vitest';
import { mergeAllowLists } from './project';

describe('mergeAllowLists', () => {
  it('adds the project list to the global one', () => {
    expect(mergeAllowLists('npm test', 'cargo check')).toBe('npm test\ncargo check');
    expect(mergeAllowLists('', 'cargo check')).toBe('\ncargo check');
  });

  it('keeps the global list when the project has none', () => {
    expect(mergeAllowLists('npm test', undefined)).toBe('npm test');
    expect(mergeAllowLists('npm test', '  \n ')).toBe('npm test');
  });
});
