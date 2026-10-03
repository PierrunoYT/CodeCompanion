// Runs after `npm install`. node-pty 1.1.0's package ships its macOS spawn-helper without the execute bit, and the
// install script that would otherwise fix it is skipped (npm 11 runs dependency scripts only for allowScripts). Without
// it every terminal start fails with `posix_spawnp failed`, in development and in the packaged app alike.
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join('node_modules', 'node-pty');
const helpers = [join(root, 'build', 'Release', 'spawn-helper')];
const prebuilds = join(root, 'prebuilds');
if (existsSync(prebuilds)) {
  for (const dir of readdirSync(prebuilds)) helpers.push(join(prebuilds, dir, 'spawn-helper'));
}

if (process.platform !== 'win32') {
  for (const helper of helpers) {
    if (!existsSync(helper)) continue;
    const mode = statSync(helper).mode;
    if ((mode & 0o111) !== 0o111) chmodSync(helper, mode | 0o111);
  }
}
