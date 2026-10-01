// electron-builder afterPack hook. A universal macOS build packages x64 and arm64 separately, then merges
// them. node-pty's darwin-arm64 prebuild is a universal Mach-O, so it is byte-identical in both packages and
// @electron/universal refuses to merge unless it is declared (mac.x64ArchFiles). The other prebuilds are not
// needed in the app and would be the same problem, so each architecture build keeps only its own.
import { rmSync } from 'node:fs';
import { join } from 'node:path';

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const arch = context.arch === 1 ? 'x64' : context.arch === 3 ? 'arm64' : null;
  if (!arch) return;
  const other = arch === 'x64' ? 'arm64' : 'x64';
  const prebuilds = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'node_modules',
    'node-pty',
    'prebuilds',
  );
  rmSync(join(prebuilds, `darwin-${other}`), { recursive: true, force: true });
  rmSync(join(prebuilds, 'win32-x64'), { recursive: true, force: true });
  rmSync(join(prebuilds, 'win32-arm64'), { recursive: true, force: true });
}
