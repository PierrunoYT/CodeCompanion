// Characters that let a shell run something else or redirect output: chaining (; & |), substitution (` $( ), and
// redirection (< >), plus line breaks. A command containing any of them is never pre-approved, so an allowed prefix
// such as "npm test" cannot be extended into "npm test && rm -rf ." or "npm test > ~/.bashrc".
const SHELL_OPERATORS = /[;&|`<>\r\n]|\$\(/;

export function parseAllowedCommands(setting: string): string[] {
  return setting
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter((line) => line && !line.startsWith('#'));
}

// True when the command is exactly one of the allowed commands, or one of them followed by arguments.
export function isCommandAllowed(command: string, setting: string): boolean {
  const normalized = command.trim().replace(/\s+/g, ' ');
  if (!normalized || SHELL_OPERATORS.test(command)) return false;
  return parseAllowedCommands(setting).some((entry) => normalized === entry || normalized.startsWith(`${entry} `));
}
