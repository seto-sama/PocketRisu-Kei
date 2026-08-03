import { describe, expect, it, vi } from 'vitest'
import { registerLuaEffectApis, type LuaEffectAdapter } from './luaCore'

describe('Lua effect API registry', () => {
    it('applies shared safe and low-level permissions before invoking adapters', async () => {
        const apis: Record<string, (...args: unknown[]) => unknown> = {}
        const invoke = vi.fn((_name, args) => args[1])
        const adapter: LuaEffectAdapter = {
            canUseSafeApi: key => key === 'safe' || key === 'low',
            canUseLowLevelApi: key => key === 'low',
            invoke,
        }
        registerLuaEffectApis((name, handler) => { apis[name] = handler }, () => adapter)

        expect(apis.alertNormal('denied', 'hidden')).toBeUndefined()
        expect(apis.alertNormal('safe', 'visible')).toBe('visible')
        expect(await apis.similarity('safe', 'source', [])).toEqual([])
        expect(apis.similarity('low', 'source', [])).toBe('source')
        expect(JSON.parse(String(apis.LLMMain('safe', '[]')))).toEqual({
            success: false,
            result: 'Low-level access is disabled',
        })
        expect(apis.logMain('message')).toBeUndefined()
        expect(invoke).toHaveBeenCalledTimes(3)
    })
})
