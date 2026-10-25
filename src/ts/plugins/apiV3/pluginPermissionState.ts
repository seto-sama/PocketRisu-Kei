export type PluginPermissionDesc = 'fetchLogs' | 'db' | 'mainDom' | 'replacer' | 'provider' | 'sendChat' | 'inlay'

export class PluginPermissionDialogQueue {
    private chain: Promise<unknown> = Promise.resolve()

    async request(
        resolve: () => Promise<boolean | undefined>,
        prompt: () => Promise<boolean>,
    ): Promise<boolean> {
        const early = await resolve()
        if (early !== undefined) return early

        const run = this.chain.then(async () => {
            const current = await resolve()
            return current ?? prompt()
        })
        this.chain = run.catch(() => {})
        return run
    }
}
