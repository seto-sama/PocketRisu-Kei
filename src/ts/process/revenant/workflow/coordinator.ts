import type { RevenantGenerationLifecycle } from '../types'

export type { RevenantGenerationLifecycle } from '../types'

export interface RevenantGenerationCoordinatorOptions<T> extends RevenantGenerationLifecycle {
    /** True when the returned value is a live stream whose transport is still starting. */
    resultKeepsRegistrationOpen?: (result: T) => boolean
}

export interface CoordinatedRevenantGeneration<T> {
    /**
     * Resolves as soon as the durable server job exists. From this point on the
     * server owns dispatch even if the originating client disconnects. An
     * undefined value means the request finished or failed before registration.
     */
    registered: Promise<string | undefined>
    /** The ordinary request result, including its streamed provider response. */
    result: Promise<T>
}

export function combineProviderStartedHandlers(
    ...handlers: Array<((startedAt: number) => void) | undefined>
): ((startedAt: number) => void) | undefined {
    const activeHandlers = handlers.filter(
        (handler): handler is (startedAt: number) => void => !!handler,
    )
    if (activeHandlers.length === 0) return undefined
    return startedAt => {
        for (const handler of activeHandlers) handler(startedAt)
    }
}

/**
 * Starts request preparation immediately, while exposing the earlier durable
 * registration boundary separately from the eventual provider result.
 */
export function coordinateRevenantGeneration<T>(
    start: (lifecycle: Required<RevenantGenerationLifecycle>) => Promise<T>,
    options: RevenantGenerationCoordinatorOptions<T> = {},
): CoordinatedRevenantGeneration<T> {
    let registrationSettled = false
    let settleRegistration!: (jobId: string | undefined) => void
    const registered = new Promise<string | undefined>(resolve => {
        settleRegistration = resolve
    })
    const settleOnce = (jobId: string | undefined) => {
        if (registrationSettled) return
        registrationSettled = true
        settleRegistration(jobId)
    }

    const result = Promise.resolve().then(() => start({
        onJobCreated(jobId) {
            settleOnce(jobId)
            options.onJobCreated?.(jobId)
        },
        onJobRegistrationUnavailable(error) {
            settleOnce(undefined)
            options.onJobRegistrationUnavailable?.(error)
        },
        onProviderStarted(startedAt) {
            options.onProviderStarted?.(startedAt)
        },
        onTerminal(terminal) {
            options.onTerminal?.(terminal)
        },
    }))

    // Request preparation can fail before it reaches the durable endpoint.
    // A streaming response is only a live handle, so keep waiting until its
    // transport reports either job creation or registration unavailability.
    void result.then(
        value => {
            if (!options.resultKeepsRegistrationOpen?.(value)) settleOnce(undefined)
        },
        () => settleOnce(undefined),
    )

    return { registered, result }
}
