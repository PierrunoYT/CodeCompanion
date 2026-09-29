import { describe, expect, it } from 'vitest';
import { isCommandAllowed, parseAllowedCommands } from './allowed_commands';

const allowed = 'npm test\n# comments and blank lines are ignored\n\ngit   status\nnpm run lint';

describe('parseAllowedCommands', () => {
  it('drops blank lines and comments and collapses whitespace', () => {
    expect(parseAllowedCommands(allowed)).toEqual(['npm test', 'git status', 'npm run lint']);
  });
});

describe('isCommandAllowed', () => {
  it('allows an allowed command with or without arguments', () => {
    expect(isCommandAllowed('npm test', allowed)).toBe(true);
    expect(isCommandAllowed('  npm   test -- --watch=false ', allowed)).toBe(true);
    expect(isCommandAllowed('git status', allowed)).toBe(true);
  });

  it('matches whole words only', () => {
    expect(isCommandAllowed('npm testing', allowed)).toBe(false);
    expect(isCommandAllowed('npm', allowed)).toBe(false);
    expect(isCommandAllowed('git statuses', allowed)).toBe(false);
  });

  it('rejects commands that are not on the list', () => {
    expect(isCommandAllowed('rm -rf .', allowed)).toBe(false);
    expect(isCommandAllowed('npm install', allowed)).toBe(false);
    expect(isCommandAllowed('anything', '')).toBe(false);
  });

  it.each([
    'npm test && rm -rf .',
    'npm test; rm -rf .',
    'npm test | tee out.txt',
    'npm test & calc',
    'npm test > out.txt',
    'npm test < in.txt',
    'npm test `whoami`',
    'npm test $(whoami)',
    'npm test\nrm -rf .',
  ])('never allows shell operators: %s', (command) => {
    expect(isCommandAllowed(command, allowed)).toBe(false);
  });
});
