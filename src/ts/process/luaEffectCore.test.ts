import { describe, expect, it, vi } from 'vitest'
import { registerLuaEffectApis, type LuaEffectAdapter } from './luaCore'

describe('Lua effect API registry', () => {
    function setupAdapter() {
        const apis: Record<string, (...args: unknown[]) => unknown> = {}
        const invoke = vi.fn((_name, args) => args[1])
        const adapter: LuaEffectAdapter = {
            canUseSafeApi: key => key === 'safe' || key === 'low',
            canUseLowLevelApi: key => key === 'low',
            invoke,
        }
        registerLuaEffectApis((name, handler) => { apis[name] = handler }, () => adapter)
        return { apis, invoke }
    }

    it('allows safe APIs only for safe access keys', () => {
        const { apis } = setupAdapter()
        expect(apis.alertNormal('denied', 'hidden')).toBeUndefined()
        expect(apis.alertNormal('safe', 'visible')).toBe('visible')
    })

    it('allows low-level APIs only for low-level access keys', async () => {
        const { apis } = setupAdapter()
        expect(await apis.similarity('safe', 'source', [])).toEqual([])
        expect(apis.similarity('low', 'source', [])).toBe('source')
        expect(JSON.parse(String(apis.LLMMain('safe', '[]')))).toEqual({
            success: false,
            result: 'Low-level access is disabled',
        })
    })

    it('allows public APIs without an access key', () => {
        const { apis, invoke } = setupAdapter()
        expect(apis.logMain('message')).toBeUndefined()
        expect(invoke).toHaveBeenCalledWith('logMain', ['message'])
    })
})
