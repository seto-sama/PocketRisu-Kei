import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const repo = process.cwd()
const updateShell = resolve(repo, 'update.sh')
const portableUpdater = resolve(repo, 'scripts/updater.cjs')
const updateManifest = resolve(repo, 'shared/updateManifest.cjs')
const load = createRequire(import.meta.url)
const { createUpdateManifest } = load('../shared/updateManifest.cjs') as {
  createUpdateManifest(root: string, newEntries: string[]): {
    isManaged(entry: string): boolean
    isConflict(entry: string): boolean
  }
}
const temporaryDirectories: string[] = []

const targetVersion = '2.2.1'
const releaseTag = `kei-v${targetVersion}`
const incomingTopLevel = [
  '.release-hidden',
  'collision',
  'dist',
  'package.json',
  'scripts',
  'server',
  'shared',
  'update.sh',
  'version.json',
]

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function makeIncomingPackage(root: string, archivePath: string) {
  const packageDir = join(root, 'incoming', 'PocketRisu-Kei-v2.2.1')
  mkdirs(packageDir, ['dist', 'server', 'scripts', 'shared', 'collision'])

  writeFileSync(join(packageDir, 'dist', 'index.html'), 'release html')
  writeFileSync(join(packageDir, 'server', 'release.txt'), 'release server')
  writeFileSync(join(packageDir, 'scripts', 'updater.cjs'), readFileSync(portableUpdater))
  writeFileSync(join(packageDir, 'shared', 'updateManifest.cjs'), readFileSync(updateManifest))
  copyFileSync(updateShell, join(packageDir, 'update.sh'))
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ version: targetVersion }))
  writeFileSync(join(packageDir, 'version.json'), JSON.stringify({ version: targetVersion }))
  writeFileSync(join(packageDir, '.release-hidden'), 'release hidden file')
  writeFileSync(join(packageDir, 'collision', 'release.txt'), 'release collision')

  execFileSync('tar', ['-czf', archivePath, '-C', join(root, 'incoming'), 'PocketRisu-Kei-v2.2.1'])
}

function makeInstall(root: string, withManifest: boolean, kind: 'shell' | 'portable') {
  const appDir = join(root, 'app')
  mkdirs(appDir, [
    'dist', 'server', 'scripts', 'shared', 'collision', 'save',
    'user-data/nested', 'obsolete-managed', `backups/update-conflict-v${targetVersion}`,
  ])

  writeFileSync(join(appDir, '.installed-version'), 'v2.2.0')
  writeFileSync(join(appDir, 'package.json'), JSON.stringify({ version: '2.2.0' }))
  writeFileSync(join(appDir, 'dist', 'index.html'), 'old html')
  writeFileSync(join(appDir, 'server', 'old.txt'), 'old server')
  writeFileSync(join(appDir, 'collision', 'user.txt'), 'user collision')
  writeFileSync(join(appDir, 'user-data', 'nested', 'keep.txt'), 'user directory')
  writeFileSync(join(appDir, '.user-hidden'), 'user hidden file')
  writeFileSync(join(appDir, 'save', 'keep.txt'), 'saved user data')
  writeFileSync(join(appDir, 'obsolete-managed', 'old.txt'), 'obsolete app entry')
  writeFileSync(
    join(appDir, 'backups', `update-conflict-v${targetVersion}`, 'collision'),
    'previously archived user file',
  )

  if (withManifest) {
    writeFileSync(
      join(appDir, '.installed-manifest'),
      ['dist', 'server', 'package.json', 'scripts', 'shared', 'update.sh', 'obsolete-managed'].join('\n') + '\n',
    )
  }

  copyFileSync(updateShell, join(appDir, 'update.sh'))
  if (kind === 'portable') {
    copyFileSync(portableUpdater, join(appDir, 'scripts', 'updater.cjs'))
    copyFileSync(updateManifest, join(appDir, 'shared', 'updateManifest.cjs'))
  }
  return appDir
}

function mkdirs(root: string, directories: string[]) {
  mkdirSync(root, { recursive: true })
  for (const directory of directories) mkdirSync(join(root, directory), { recursive: true })
}

function makeShellMocks(root: string) {
  const bin = join(root, 'mock-bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"api.github.com"* ]]; then
  printf '{"tag_name":"${releaseTag}"}'
  exit 0
fi
destination=""
while (($#)); do
  if [[ "$1" == "-o" ]]; then destination="$2"; shift 2; else shift; fi
done
cp "$UPDATE_ARCHIVE" "$destination"
`, { mode: 0o755 })
  writeFileSync(join(bin, 'pnpm'), '#!/usr/bin/env bash\nif [[ "${1:-}" == "build" && "${FAIL_PNPM_BUILD:-}" == "1" ]]; then exit 1; fi\nexit 0\n', { mode: 0o755 })
  return bin
}

function runShellUpdater(appDir: string, root: string, archivePath: string, failBuild = false) {
  const bin = makeShellMocks(root)
  const tempDir = join(root, 'tmp')
  mkdirSync(tempDir, { recursive: true })
  execFileSync('bash', [join(appDir, 'update.sh')], {
    cwd: appDir,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TMPDIR: tempDir,
      UPDATE_ARCHIVE: archivePath,
      ...(failBuild ? { FAIL_PNPM_BUILD: '1' } : {}),
    },
    input: 'y\n',
    stdio: ['pipe', 'ignore', 'pipe'],
  })
}

function runPortableUpdater(appDir: string, archivePath: string, failureMarker?: string) {
  const platform = process.platform === 'darwin' ? 'macos' : 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const assetName = `PocketRisu-Kei-v${targetVersion}-${platform}-${arch}.tar.gz`
  const failureHook = failureMarker ? `
    const path = require('node:path');
    const originalRenameSync = fs.renameSync;
    let failedPackageInstall = false;
    fs.renameSync = function (source, destination) {
      if (!failedPackageInstall
        && String(source).includes(path.join('.update-tmp', 'extracted'))
        && path.basename(String(source)) === 'package.json') {
        failedPackageInstall = true;
        fs.writeFileSync(process.env.UPDATE_FAILURE_MARKER, 'injected');
        const error = new Error('injected package install failure');
        error.code = 'EIO';
        throw error;
      }
      return Reflect.apply(originalRenameSync, this, [source, destination]);
    };
  ` : ''
  const bootstrap = `
    const https = require('node:https');
    const { EventEmitter } = require('node:events');
    const { Readable } = require('node:stream');
    const fs = require('node:fs');
    ${failureHook}
    https.get = (url, _options, callback) => {
      const body = String(url).includes('/releases/latest')
        ? Buffer.from(JSON.stringify({
            tag_name: ${JSON.stringify(releaseTag)},
            html_url: 'https://example.invalid/release',
            assets: [{ name: ${JSON.stringify(assetName)}, browser_download_url: 'https://example.invalid/archive' }],
          }))
        : fs.readFileSync(process.env.UPDATE_ARCHIVE);
      const response = Readable.from([body]);
      response.statusCode = 200;
      response.headers = { 'content-length': String(body.length) };
      process.nextTick(() => callback(response));
      return new EventEmitter();
    };
    require(process.env.UPDATE_ENTRY);
  `
  execFileSync(process.execPath, ['-e', bootstrap], {
    cwd: appDir,
    env: {
      ...process.env,
      UPDATE_ARCHIVE: archivePath,
      UPDATE_ENTRY: join(appDir, 'scripts', 'updater.cjs'),
      ...(failureMarker ? { UPDATE_FAILURE_MARKER: failureMarker } : {}),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
}

function expectIncomingManifest(appDir: string) {
  const entries = readFileSync(join(appDir, '.installed-manifest'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .sort()
  expect(entries).toEqual([...incomingTopLevel].sort())
}

const updaterKinds = ['shell', 'portable'] as const
const manifestStates = [
  { name: 'with a previous manifest', hasManifest: true },
  { name: 'without a previous manifest', hasManifest: false },
]

describe.skipIf(process.platform === 'win32')('installed manifest update behavior', () => {
  it('normalizes manifest lines and treats an unreadable manifest as absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'risu-update-manifest-helper-'))
    temporaryDirectories.push(root)
    const readable = join(root, 'readable')
    const unreadable = join(root, 'unreadable')
    mkdirs(readable, [])
    mkdirs(unreadable, ['.installed-manifest'])
    writeFileSync(join(readable, '.installed-manifest'), ' dist \r\n obsolete-managed \n \r\n')

    const parsed = createUpdateManifest(readable, ['dist', 'package.json'])
    expect(parsed.isManaged('obsolete-managed')).toBe(true)
    expect(parsed.isManaged('package.json')).toBe(true)
    expect(parsed.isConflict('package.json')).toBe(true)

    const absent = createUpdateManifest(unreadable, ['incoming'])
    expect(absent.isManaged('incoming')).toBe(true)
    expect(absent.isManaged('unknown')).toBe(false)
    expect(absent.isConflict('incoming')).toBe(false)
  })

  it.each(updaterKinds.flatMap(kind => manifestStates.map(state => ({ kind, ...state }))))(
    '$kind updater preserves user entries and tracks the incoming package $name',
    ({ kind, hasManifest }) => {
      const root = mkdtempSync(join(tmpdir(), 'risu-update-manifest-'))
      temporaryDirectories.push(root)
      const archivePath = join(root, 'release.tar.gz')
      makeIncomingPackage(root, archivePath)
      const appDir = makeInstall(root, hasManifest, kind)

      if (kind === 'shell') runShellUpdater(appDir, root, archivePath)
      else runPortableUpdater(appDir, archivePath)

      expect(readFileSync(join(appDir, 'dist', 'index.html'), 'utf8')).toBe('release html')
      expect(JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')).version).toBe(targetVersion)
      expect(readFileSync(join(appDir, '.installed-version'), 'utf8').trim()).toBe(`v${targetVersion}`)
      expectIncomingManifest(appDir)
      expect(existsSync(join(appDir, 'user-data', 'nested', 'keep.txt'))).toBe(true)
      expect(readFileSync(join(appDir, '.user-hidden'), 'utf8')).toBe('user hidden file')
      expect(readFileSync(join(appDir, 'save', 'keep.txt'), 'utf8')).toBe('saved user data')
      expect(existsSync(join(appDir, 'obsolete-managed'))).toBe(!hasManifest)
      expect(readFileSync(join(appDir, 'collision', 'release.txt'), 'utf8')).toBe('release collision')

      const conflictDir = join(appDir, 'backups', `update-conflict-v${targetVersion}`)
      if (hasManifest) {
        expect(readFileSync(join(conflictDir, 'collision'), 'utf8')).toBe('previously archived user file')
        expect(readFileSync(join(conflictDir, 'collision.1', 'user.txt'), 'utf8')).toBe('user collision')
      } else {
        expect(existsSync(join(conflictDir, 'collision.1'))).toBe(false)
      }
    },
  )

  it('portable updater restores the prior app and manifest after a package install failure', () => {
    const root = mkdtempSync(join(tmpdir(), 'risu-update-manifest-rollback-'))
    temporaryDirectories.push(root)
    const archivePath = join(root, 'release.tar.gz')
    makeIncomingPackage(root, archivePath)
    const appDir = makeInstall(root, true, 'portable')
    const previousManifest = readFileSync(join(appDir, '.installed-manifest'), 'utf8')
    const failureMarker = join(root, 'failure-injected')

    expect(() => runPortableUpdater(appDir, archivePath, failureMarker)).toThrow()
    expect(existsSync(failureMarker)).toBe(true)
    expect(JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')).version).toBe('2.2.0')
    expect(readFileSync(join(appDir, '.installed-version'), 'utf8')).toBe('v2.2.0')
    expect(readFileSync(join(appDir, '.installed-manifest'), 'utf8')).toBe(previousManifest)
    expect(readFileSync(join(appDir, 'dist', 'index.html'), 'utf8')).toBe('old html')
    expect(readFileSync(join(appDir, 'user-data', 'nested', 'keep.txt'), 'utf8')).toBe('user directory')
    expect(readFileSync(join(appDir, '.user-hidden'), 'utf8')).toBe('user hidden file')
  })

  it('records the incoming manifest before a shell build failure without advancing the version', () => {
    const root = mkdtempSync(join(tmpdir(), 'risu-update-manifest-build-failure-'))
    temporaryDirectories.push(root)
    const archivePath = join(root, 'release.tar.gz')
    makeIncomingPackage(root, archivePath)
    const appDir = makeInstall(root, true, 'shell')

    expect(() => runShellUpdater(appDir, root, archivePath, true)).toThrow()
    expectIncomingManifest(appDir)
    expect(readFileSync(join(appDir, '.installed-version'), 'utf8')).toBe('v2.2.0')
  })
})
