#!/usr/bin/env node

const { copyFileSync, mkdirSync, rmSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = join(__dirname, '..');
const electronVersion = require('electron/package.json').version;
const betterSqliteRoot = dirname(require.resolve('better-sqlite3/package.json'));
const betterSqliteBinary = join(betterSqliteRoot, 'build', 'Release', 'better_sqlite3.node');

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

const readElectronModuleVersion = () => {
  const result = spawnSync(
    process.platform === 'win32' ? 'node_modules\\.bin\\electron.cmd' : './node_modules/.bin/electron',
    ['-p', 'process.versions.modules'],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1'
      },
      shell: process.platform === 'win32'
    }
  );

  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  return result.stdout.trim();
};

const electronModuleVersion = readElectronModuleVersion();
const nativeDirectory = join(
  projectRoot,
  'native',
  `electron-v${electronModuleVersion}-${process.platform}-${process.arch}`
);
const nativeBinary = join(nativeDirectory, 'better_sqlite3.node');

console.log(`[uchat] rebuilding better-sqlite3 for Node ABI ${process.versions.modules}`);
run('pnpm', ['rebuild', 'better-sqlite3']);

console.log(`[uchat] rebuilding better-sqlite3 for Electron ${electronVersion} ABI ${electronModuleVersion}`);
run('pnpm', ['exec', 'electron-rebuild', '-f', '-w', 'better-sqlite3', '-v', electronVersion]);

mkdirSync(nativeDirectory, { recursive: true });
copyFileSync(betterSqliteBinary, nativeBinary);
console.log(`[uchat] copied Electron native binding to ${nativeBinary}`);

console.log(`[uchat] restoring better-sqlite3 for Node ABI ${process.versions.modules}`);
run('pnpm', ['rebuild', 'better-sqlite3']);

rmSync(join(projectRoot, 'native', '.keep'), { force: true });
