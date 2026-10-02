// Files an edit must never touch without the user looking at it, even in Auto mode: credentials and keys, Git
// internals, and the folders of editors and agents (their config can change what runs on the machine), shell start-up
// files, databases, and system folders. Paths are project-relative with forward slashes, or absolute for a file
// outside the project.

const GUARDED: RegExp[] = [
  // Credentials and keys. Example files such as .env.example hold no secrets and stay open.
  /(^|\/)\.env(\.(?!example$|sample$|template$|dist$)[^/]+)?$/i,
  /(^|\/)\.(ssh|gnupg|aws|kube|azure|docker)(\/|$)/,
  /(^|\/)\.(npmrc|netrc|pypirc)$/,
  /\.(pem|key|p12|pfx|keystore|jks|kdbx)$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/,
  /(^|\/)\.config\/gcloud\//,
  // Version-control internals.
  /(^|\/)\.git(\/|$)/,
  // Editor and agent configuration.
  /(^|\/)\.(cursor|windsurf|claude|codex|vscode|idea|amp)(\/|$)/,
  // Shell start-up files.
  /(^|\/)\.(bashrc|bash_profile|zshrc|zprofile|profile|zshenv)$/,
  /(^|\/)\.config\/fish\//,
  // Databases.
  /\.(sqlite3?|db)$/i,
  // System folders.
  /^[A-Za-z]:\/(Windows|Program Files)/i,
  /^\/(etc|boot|sys|proc)\//,
];

export function isGuardedPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return GUARDED.some((pattern) => pattern.test(normalized));
}
