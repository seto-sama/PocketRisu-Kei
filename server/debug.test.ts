import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { parse } from 'node-html-parser'
import { afterEach, expect, it, vi } from 'vitest'
import { isDebugEnabled } from '../src/ts/debug'

const temporaryDirectories: string[] = []

function temporaryDirectory() {
    const directory = mkdtempSync(join(tmpdir(), 'risu-debug-'))
    temporaryDirectories.push(directory)
    return directory
}

afterEach(() => {
    vi.unstubAllGlobals()
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

it.each([
    ['production', '', false],
    ['development', '', false],
    ['production', 'pocketrisu', true],
] as const)('shares the server debug setting with the browser (%s, NODE_DEBUG=%s)', (nodeEnv, nodeDebug, enabled) => {
    const directory = temporaryDirectory()
    mkdirSync(join(directory, 'dist'))
    writeFileSync(join(directory, 'dist', 'index.html'), '<html><head><script type="module" src="/app.js"></script></head><body></body></html>')
    const output = spawnSync(process.execPath, ['-e', `
        const { logger, countLogs } = require(${JSON.stringify(resolve('server/logs/logs.cjs'))});
        const { installWebRoutes } = require(${JSON.stringify(resolve('server/routes/web.cjs'))});
        const count = countLogs();
        logger.debug('debug-probe');
        let handler;
        installWebRoutes({ get(path, callback) { handler = callback; } }, {
            enablePatchSync: true, isCloudflareTunnelRequest: () => false,
        });
        handler({ ip: 'test' }, {
            set(name, value) { if (name === 'Cache-Control' && value !== 'no-store') throw new Error('Runtime config must not be cached'); },
            send(html) { console.log(JSON.stringify({ html, logs: countLogs() - count })); },
        }).catch(error => { console.error(error); process.exitCode = 1; });
    `], {
        cwd: directory,
        env: { ...process.env, NODE_ENV: nodeEnv, NODE_DEBUG: nodeDebug },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(output.status, output.stderr).toBe(0)
    expect(output.stderr.includes('debug-probe')).toBe(enabled)
    const result = JSON.parse(output.stdout.trim().split('\n').at(-1)!)
    const scripts = parse(result.html).querySelectorAll('head script')
    const browser = runInNewContext(scripts[0].textContent + '\nglobalThis')
    vi.stubGlobal('__POCKETRISU_DEBUG__', browser.__POCKETRISU_DEBUG__)
    expect(isDebugEnabled()).toBe(enabled)
    expect(scripts[1].getAttribute('src')).toBe('/app.js')
    expect(result.logs).toBe(0)
})

it.each([
    { command: [], args: [] },
    { command: ['probe', 'argument with spaces'], args: ['argument with spaces'] },
])('launches a package script with debug enabled ($command)', ({ command, args }) => {
    const directory = temporaryDirectory()
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ scripts: { runserver: 'node probe.cjs', probe: 'node probe.cjs' } }))
    writeFileSync(join(directory, 'probe.cjs'), `
        const { debuglog } = require('node:util');
        console.log(JSON.stringify({
            debug: debuglog('pocketrisu').enabled, existingDebug: debuglog('other').enabled,
            mode: process.env.NODE_ENV, args: process.argv.slice(2),
        }));
    `)
    const output = execFileSync(process.execPath, [resolve('server/debug.cjs'), ...command], {
        cwd: directory,
        env: { ...process.env, NODE_ENV: 'production', NODE_DEBUG: 'other' },
        encoding: 'utf8',
    })
    expect(JSON.parse(output)).toEqual({
        debug: true, existingDebug: true, mode: 'production', args,
    })
})
