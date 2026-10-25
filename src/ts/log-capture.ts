// Capture console warnings/errors and unhandled errors in system logs.
// Debug output stays in the console and is not persisted.
import { addLog, type LogLevel } from './log'

// Keep native methods so callers that already use addLog can avoid duplicate entries.
export const nativeConsoleError = console.error.bind(console)
export const nativeConsoleWarn = console.warn.bind(console)

let installed = false
let inLog = false

function formatArg(arg: unknown): string {
    if (arg instanceof Error) return arg.stack || arg.message || String(arg)
    if (arg === null || arg === undefined) return String(arg)
    if (typeof arg === 'string') return arg
    try { return JSON.stringify(arg) } catch { return String(arg) }
}

function buildEntry(args: unknown[]): { message: string; description?: string } {
    if (args.length === 0) return { message: '' }
    if (args.length === 1) {
        const a = args[0]
        if (a instanceof Error) return { message: a.message || String(a), description: a.stack }
        return { message: formatArg(a) }
    }
    const [first, ...rest] = args
    return { message: formatArg(first), description: rest.map(formatArg).join(' ') }
}

function patch(level: LogLevel, orig: (...a: unknown[]) => void): (...a: unknown[]) => void {
    return (...args: unknown[]) => {
        if (!inLog) {
            inLog = true
            try {
                const { message, description } = buildEntry(args)
                addLog({ level, message, description, source: 'console' })
            } catch { /* never crash callers */ }
            finally { inLog = false }
        }
        orig.apply(console, args)
    }
}

function installConsolePatch() {
    console.error = patch('error', nativeConsoleError)
    console.warn = patch('warning', nativeConsoleWarn)
}

function installGlobalHandlers() {
    if (typeof window === 'undefined') return

    window.addEventListener('error', (ev) => {
        const err = ev.error instanceof Error ? ev.error : null
        addLog({
            level: 'error',
            message: ev.message || 'uncaught error',
            description: err?.stack ?? (ev.filename ? `at ${ev.filename}:${ev.lineno ?? '?'}:${ev.colno ?? '?'}` : undefined),
            source: 'uncaught',
        })
    })

    window.addEventListener('unhandledrejection', (ev) => {
        const reason = ev.reason
        const err = reason instanceof Error ? reason : null
        addLog({
            level: 'error',
            message: err?.message || String(reason),
            description: err?.stack,
            source: 'promise',
        })
    })
}

export function installLogCapture() {
    if (installed) return
    installed = true
    installConsolePatch()
    installGlobalHandlers()
}

installLogCapture()
