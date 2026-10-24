import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const childProcess = require('node:child_process')
const execFileAsync = promisify(childProcess.execFile)
const { logger } = require('../logs/logs.cjs')
// Load archive execution before replacing the binary lookup process in these tests.
require('../utils/decompressFile.cjs')

describe('tunnel installation', () => {
    let directory: string
    let state: any
    let handlers: Record<string, (req: any, res: any) => Promise<unknown>>
    let spawn: ReturnType<typeof vi.spyOn>

    const response = () => {
        const res = { status: vi.fn(), json: vi.fn() }
        res.status.mockReturnValue(res)
        return res
    }

    beforeEach(async () => {
        directory = await mkdtemp(path.join(tmpdir(), 'tunnel-install-'))
        vi.spyOn(process, 'cwd').mockReturnValue(directory)
        vi.stubEnv('RISU_TUNNEL_DISABLED', 'false')
        vi.spyOn(logger, 'error').mockImplementation(() => {})
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(childProcess, 'execFile').mockImplementation((...args: any[]) => {
            queueMicrotask(() => args.at(-1)(new Error('not installed')))
        })
        spawn = vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
            const child = new EventEmitter() as any
            child.stderr = new EventEmitter()
            child.kill = vi.fn()
            return child
        })
        state = { tunnelStatus: 'off', tunnelUrl: null, tunnelError: null }
        handlers = {}
        delete require.cache[require.resolve('./tunnel.cjs')]
        const { installTunnelRoutes } = require('./tunnel.cjs')
        installTunnelRoutes({
            get: () => {},
            post: (url: string, handler: any) => { handlers[url] = handler },
        }, {
            checkAuth: async () => true,
            tunnelState: state,
            stopTunnel: () => {
                clearTimeout(state.tunnelStartTimeout)
                state.tunnelStartTimeout = null
                state.tunnelProcess?.kill()
                state.tunnelProcess = null
                state.tunnelStatus = 'off'
                state.tunnelUrl = null
                state.tunnelError = null
            },
        })
    })

    afterEach(async () => {
        clearTimeout(state.tunnelStartTimeout)
        vi.restoreAllMocks()
        vi.unstubAllGlobals()
        vi.unstubAllEnvs()
        await rm(directory, { recursive: true, force: true })
    })

    it('publishes a complete executable before starting the tunnel', async () => {
        const bytes = Uint8Array.of(0, 127, 128, 255)
        let artifact: Uint8Array = bytes
        if (process.platform === 'darwin') {
            const source = path.join(directory, 'source')
            const archive = path.join(directory, 'cloudflared.tgz')
            await mkdir(source)
            await writeFile(path.join(source, 'cloudflared'), bytes)
            await execFileAsync('tar', ['-czf', archive, '-C', source, 'cloudflared'])
            artifact = await readFile(archive)
        }
        vi.stubGlobal('fetch', vi.fn(async () => new Response(artifact)))
        const res = response()
        await handlers['/api/tunnel/start']({}, res)
        const binaryName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
        const binaryPath = path.join(directory, 'bin', binaryName)
        expect(res.json).toHaveBeenCalledWith({ status: 'downloading' })
        expect(await readFile(binaryPath)).toEqual(Buffer.from(bytes))
        if (process.platform !== 'win32') expect((await stat(binaryPath)).mode & 0o777).toBe(0o755)
        expect(await readdir(path.dirname(binaryPath))).toEqual([binaryName])
        expect(spawn).toHaveBeenCalledWith(binaryPath, expect.any(Array), expect.any(Object))
        expect(state.tunnelStatus).toBe('starting')
    })

    it('cleans up a truncated download without publishing or starting it', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
            start(controller) { controller.enqueue(Uint8Array.of(1, 2, 3)) },
            pull(controller) { controller.error(new Error('connection reset')) },
        }))))
        await handlers['/api/tunnel/start']({}, response())
        expect(state.tunnelStatus).toBe('error')
        expect(state.tunnelError).toContain('connection reset')
        expect(await readdir(path.join(directory, 'bin'))).toEqual([])
        expect(spawn).not.toHaveBeenCalled()
    })

    it('rejects another start request while binary lookup is pending', async () => {
        const lookup = Promise.withResolvers<(...args: any[]) => void>()
        childProcess.execFile.mockImplementation((...args: any[]) => lookup.resolve(args.at(-1)))
        const starting = handlers['/api/tunnel/start']({}, response())
        const finishLookup = await lookup.promise
        const duplicate = response()
        await handlers['/api/tunnel/start']({}, duplicate)
        expect(duplicate.status).toHaveBeenCalledWith(409)
        finishLookup(null, '', '')
        await starting
        expect(state.tunnelStatus).toBe('starting')
        expect(spawn).toHaveBeenCalledTimes(1)
    })

    it('keeps a restarted tunnel intact when the previous process emits late events', async () => {
        const binDir = path.join(directory, 'bin')
        await mkdir(binDir)
        await writeFile(path.join(binDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'), '')
        await handlers['/api/tunnel/start']({}, response())
        const first = state.tunnelProcess
        first.stderr.emit('data', Buffer.from('https://first.trycloudflare.com'))
        expect(state.tunnelStatus).toBe('running')

        await handlers['/api/tunnel/stop']({}, response())
        await handlers['/api/tunnel/start']({}, response())
        const second = state.tunnelProcess
        const timer = state.tunnelStartTimeout
        first.stderr.emit('data', Buffer.from('https://first.trycloudflare.com'))
        first.emit('error', new Error('old process error'))
        first.emit('exit', 0)

        expect(state.tunnelProcess).toBe(second)
        expect(state.tunnelStatus).toBe('starting')
        expect(state.tunnelUrl).toBeNull()
        expect(state.tunnelError).toBeNull()
        expect(state.tunnelStartTimeout).toBe(timer)
        second.stderr.emit('data', Buffer.from('https://second.trycloudflare.com'))
        expect(state.tunnelStatus).toBe('running')
        expect(state.tunnelUrl).toBe('https://second.trycloudflare.com')
    })
})
