import { consumeRecoverableAuxiliaryGeneration } from '../auxiliary'

export type RevenantAuxiliaryResultPolicy =
    | 'automatic'
    | 'caller'
    | 'retain-success'

/**
 * Select the durable jobs which the shared request boundary may acknowledge.
 * `retain-success` leaves only the final successful attempt for a domain to
 * commit (for example, writing a translation cache) while cleaning failures
 * and superseded attempts through the same common pipeline.
 */
export function auxiliaryResultJobIdsToConsume(
    policy: RevenantAuxiliaryResultPolicy,
    responseType: 'success' | 'fail' | 'streaming' | 'multiline',
    jobIds: Iterable<string>,
): string[] {
    const ids = [...new Set(jobIds)]
    if (policy === 'automatic') return ids
    if (policy === 'caller') return []
    if (responseType === 'fail') return ids
    if (responseType === 'success') return ids.slice(0, -1)
    return []
}

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
