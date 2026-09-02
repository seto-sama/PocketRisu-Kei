export interface RepetitionMatch {
    /** Number of completed sentence/line units in one repeated block. */
    blockSize: number
    /** Repetitions after the first occurrence. */
    repeats: number
}

export const OUTPUT_REPETITION_DISABLED = -1000
export const OUTPUT_REPETITION_MIN = 1
export const OUTPUT_REPETITION_MAX = 16

export function normalizeOutputRepetitionLimit(value: unknown): number | undefined {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < OUTPUT_REPETITION_MIN) return undefined
    return Math.min(OUTPUT_REPETITION_MAX, Math.floor(parsed))
}

const UNIT_END = /[.!?。！？…\n]/
const TRAILING_END = /[.!?。！？…\s]+$/u
const EDGE_QUOTES = /^[\s"'“”‘’«»「」『』()[\]{}]+|[\s"'“”‘’«»「」『』()[\]{}]+$/gu
const THOUGHTS_OPEN = '<Thoughts>\n'
const THOUGHTS_CLOSE = '\n</Thoughts>\n\n'

function normalizeUnit(value: string): string {
    return value
        .replace(TRAILING_END, '')
        .trim()
        .replace(EDGE_QUOTES, '')
        .replace(/\s+/gu, ' ')
}

function splitSnapshotChannels(snapshot: string): Array<[suffix: string, text: string]> {
    if (!snapshot.startsWith(THOUGHTS_OPEN)) return [['output', snapshot]]

    const closeAt = snapshot.indexOf(THOUGHTS_CLOSE, THOUGHTS_OPEN.length)
    if (closeAt < 0) return [['output', snapshot]]
    return [
        ['thoughts', snapshot.slice(THOUGHTS_OPEN.length, closeAt)],
        ['output', snapshot.slice(closeAt + THOUGHTS_CLOSE.length)],
    ]
}

/**
 * Detects a repeated suffix made from completed sentence/line units.
 * `repeatLimit` counts copies after the original, so a value of 1 detects
 * `A A` (or `A B A B`) rather than treating the first occurrence as a repeat.
 */
export class OutputRepetitionDetector {
    private snapshot = ''
    private pending = ''
    private units: string[] = []

    constructor(private readonly repeatLimit: number) {}

    update(snapshot: string): RepetitionMatch | null {
        if (!snapshot.startsWith(this.snapshot)) {
            this.snapshot = ''
            this.pending = ''
            this.units = []
        }

        const appended = snapshot.slice(this.snapshot.length)
        this.snapshot = snapshot
        this.pending += appended

        let unitStart = 0
        let completedUnit = false
        for (let i = 0; i < this.pending.length; i += 1) {
            if (!UNIT_END.test(this.pending[i])) continue

            // Treat a run of terminators as one boundary. This keeps blank
            // lines and ellipses from becoming artificial repeated units.
            while (i + 1 < this.pending.length && UNIT_END.test(this.pending[i + 1])) {
                i += 1
            }
            const unit = normalizeUnit(this.pending.slice(unitStart, i + 1))
            unitStart = i + 1
            if (unit) {
                this.units.push(unit)
                completedUnit = true
            }
        }
        this.pending = this.pending.slice(unitStart)

        // Streaming snapshots arrive much more often than sentence boundaries.
        // A suffix cannot become newly repetitive until another unit completes.
        return completedUnit ? this.findRepeatedSuffix() : null
    }

    private findRepeatedSuffix(): RepetitionMatch | null {
        const copies = Math.max(1, Math.floor(this.repeatLimit)) + 1
        const maxBlockSize = Math.floor(this.units.length / copies)

        for (let blockSize = 1; blockSize <= maxBlockSize; blockSize += 1) {
            const blockStart = this.units.length - blockSize
            let matches = true
            for (let copy = 1; copy < copies && matches; copy += 1) {
                const previousStart = blockStart - copy * blockSize
                for (let offset = 0; offset < blockSize; offset += 1) {
                    if (this.units[previousStart + offset] !== this.units[blockStart + offset]) {
                        matches = false
                        break
                    }
                }
            }
            if (matches) return { blockSize, repeats: copies - 1 }
        }
        return null
    }
}

/**
 * Relays accumulated-text snapshots until a repeated suffix is found. The
 * triggering snapshot is delivered before the source is cancelled, preserving
 * the partial response already received from the model.
 */
export function cancelOnOutputRepetition<T extends Record<string, string>>(
    source: ReadableStream<T>,
    repeatLimit: number,
    onDetected?: () => void,
): ReadableStream<T> {
    const detectors = new Map<string, OutputRepetitionDetector>()
    let reader: ReadableStreamDefaultReader<T> | undefined

    return new ReadableStream<T>({
        start() {
            reader = source.getReader()
        },
        async pull(controller) {
            try {
                const next = await reader!.read()
                if (next.done) {
                    reader!.releaseLock()
                    reader = undefined
                    controller.close()
                    return
                }

                controller.enqueue(next.value)
                const repeated = Object.entries(next.value).some(([key, snapshot]) =>
                    splitSnapshotChannels(snapshot).some(([suffix, text]) => {
                        const channelKey = `${key}:${suffix}`
                        let detector = detectors.get(channelKey)
                        if (!detector) {
                            detector = new OutputRepetitionDetector(repeatLimit)
                            detectors.set(channelKey, detector)
                        }
                        return detector.update(text) !== null
                    }),
                )
                if (!repeated) return

                try {
                    onDetected?.()
                } catch (error) {
                    console.error('[RepetitionDetection] Detection callback failed:', error)
                }
                const activeReader = reader
                reader = undefined
                try {
                    await activeReader?.cancel('Output repetition detected')
                } finally {
                    activeReader?.releaseLock()
                    controller.close()
                }
            } catch (error) {
                reader?.releaseLock()
                reader = undefined
                controller.error(error)
            }
        },
        async cancel(reason) {
            const activeReader = reader
            reader = undefined
            try {
                await activeReader?.cancel(reason)
            } finally {
                activeReader?.releaseLock()
            }
        },
    })
}
