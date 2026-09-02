export function createSingleFlightRunner(scope: string) {
    const pending = new Set<string>()
    return function runSingleFlight(
        key: string,
        action: () => void | Promise<void>,
    ): void {
        if (pending.has(key)) return
        pending.add(key)
        void Promise.resolve()
            .then(action)
            .catch((error) => console.error(`[${scope}] ${key} action failed`, error))
            .finally(() => pending.delete(key))
    }
}
