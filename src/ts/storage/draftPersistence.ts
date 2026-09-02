import { INPUT_COMMIT_DEBOUNCE_MS } from 'src/ts/inputCommit'

export interface DebouncedDraftWriter<T> {
    schedule: (value: T) => void
    flush: (value: T) => Promise<void>
    cancel: () => void
}

/** Shared debounce/flush lifecycle for composer-like drafts. */
export function createDebouncedDraftWriter<T>(
    write: (value: T) => void | Promise<void>,
    delayMs: number | (() => number),
): DebouncedDraftWriter<T> {
    let timer: ReturnType<typeof setTimeout> | null = null

    const cancel = () => {
        if (timer === null) return
        clearTimeout(timer)
        timer = null
    }

    return {
        schedule(value) {
            cancel()
            timer = setTimeout(() => {
                timer = null
                try {
                    void Promise.resolve(write(value)).catch(() => {})
                }
                catch {
                    // localStorage and custom backends may throw synchronously.
                }
            }, typeof delayMs === 'function' ? delayMs() : delayMs)
        },
        async flush(value) {
            cancel()
            try {
                await write(value)
            }
            catch {
                // Losing a best-effort draft must not disrupt the active screen.
            }
        },
        cancel,
    }
}

export interface BrowserDraftStore<T> extends DebouncedDraftWriter<T> {
    load: () => T | null
}

/** Local-only draft storage for lightweight tool dialogs. */
export function createBrowserDraftStore<T>(
    key: string,
    delayMs = INPUT_COMMIT_DEBOUNCE_MS,
): BrowserDraftStore<T> {
    const write = (value: T) => {
        globalThis.localStorage?.setItem(key, JSON.stringify(value))
    }
    const writer = createDebouncedDraftWriter(write, delayMs)

    return {
        ...writer,
        load() {
            try {
                const raw = globalThis.localStorage?.getItem(key)
                return raw ? JSON.parse(raw) as T : null
            }
            catch {
                return null
            }
        },
    }
}
