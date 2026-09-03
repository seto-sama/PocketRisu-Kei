export type PluginPermissionDesc = 'fetchLogs' | 'db' | 'mainDom' | 'replacer' | 'provider' | 'sendChat'

export const pluginPermissionDescs: readonly PluginPermissionDesc[] = [
    'fetchLogs', 'db', 'mainDom', 'replacer', 'provider', 'sendChat',
]

export const permissionKeyOf = (pluginName: string, permissionDesc: PluginPermissionDesc) =>
    JSON.stringify([pluginName, permissionDesc])

export const permissionLastGrantKeyOf = (pluginName: string, permissionDesc: PluginPermissionDesc) =>
    `${permissionKeyOf(pluginName, permissionDesc)}_lastGrantTime`

export interface PluginPermissionState {
    given: Set<string>
    denied: Set<string>
    cache: Map<string, boolean | number>
}

export function clearPluginPermissionStateFor(state: PluginPermissionState, pluginName: string): void {
    const permissionKeys = pluginPermissionDescs.map((desc) => permissionKeyOf(pluginName, desc))
    for (const key of [pluginName, ...permissionKeys]) {
        state.given.delete(key)
        state.denied.delete(key)
    }
    for (const desc of pluginPermissionDescs) {
        state.cache.delete(permissionLastGrantKeyOf(pluginName, desc))
    }
}

export interface PluginPermissionResolution<Context> {
    resolved: boolean
    value: boolean
    context: Context
}

export class PluginPermissionDialogQueue {
    private chain: Promise<unknown> = Promise.resolve()

    async request<Context>(
        resolve: () => Promise<PluginPermissionResolution<Context>>,
        prompt: (context: Context) => Promise<boolean>,
    ): Promise<boolean> {
        const early = await resolve()
        if (early.resolved) return early.value

        const run = this.chain.catch(() => {}).then(async () => {
            const current = await resolve()
            return current.resolved ? current.value : prompt(current.context)
        })
        this.chain = run.catch(() => {})
        return run
    }
}
