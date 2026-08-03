import { consumeRecoverableAuxiliaryGeneration } from './auxiliary'

export async function consumeRevenantAuxiliaryResults(jobIds: Iterable<string>): Promise<void> {
    await Promise.all(
        [...new Set(jobIds)].map(jobId => consumeRecoverableAuxiliaryGeneration(jobId)),
    )
}

/**
 * A streaming result is consumed only after its caller has read it to EOF.
 * Cancellation and decode errors deliberately leave the job to cancellation or
 * recovery instead of acknowledging output the application did not consume.
 */
export function consumeOnStreamCompletion<T>(
    source: ReadableStream<T>,
    consume: () => Promise<void>,
): ReadableStream<T> {
    let reader: ReadableStreamDefaultReader<T> | undefined
    let consumed = false

    const consumeOnce = async () => {
        if (consumed) return
        consumed = true
        await consume()
    }

    return new ReadableStream<T>({
        start() {
            reader = source.getReader()
        },
        async pull(controller) {
            try {
                const item = await reader!.read()
                if (item.done) {
                    reader!.releaseLock()
                    reader = undefined
                    await consumeOnce()
                    controller.close()
                    return
                }
                controller.enqueue(item.value)
            }
            catch (error) {
                reader?.releaseLock()
                reader = undefined
                controller.error(error)
            }
        },
        async cancel(reason) {
            const activeReader = reader
            reader = undefined
            if (!activeReader) return
            try {
                await activeReader.cancel(reason)
            }
            finally {
                activeReader.releaseLock()
            }
        },
    })
}
