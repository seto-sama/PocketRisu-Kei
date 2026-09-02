import { describe, expect, it } from 'vitest'
import {
    IMAGE_STYLE_PRESET_MODULE_NAMESPACE,
    applyImageStylePreset,
    createImageStylePreset,
    createImageStyleLorebookFolder,
    listImageStylePresets,
} from './stylePresets'

describe('image style presets', () => {
    it('creates compatible module lorebooks', () => {
        const db = { modules: [], enabledModules: [] }
        const preset = createImageStylePreset(db, '수채화', 'watercolor', 'photo')
        const module = db.modules[0]
        const lorebook = module.lorebook![0]

        expect(module.namespace).toBe(IMAGE_STYLE_PRESET_MODULE_NAMESPACE)
        expect(db.enabledModules).toContain(module.id)
        expect(lorebook).toMatchObject({
            comment: '프리셋 수채화',
            key: '',
            insertorder: 1000,
            alwaysActive: false,
        })
        expect(lorebook.secondkey).toMatch(/^[0-9a-f-]{36}$/)
        expect(listImageStylePresets(db)[0].id).toBe(preset.id)
    })

    it('prepends ordinary preset prompts to modal input', () => {
        expect(applyImageStylePreset(
            '[Positive]\nwatercolor, soft light\n\n[Negative]\nphoto',
            '1girl, cafe',
            'blurry',
        )).toEqual({
            prompt: 'watercolor, soft light,\n1girl, cafe',
            negativePrompt: 'photo,\nblurry',
        })
    })

    it('creates presets inside a selected module', () => {
        const target = { id: 'external', name: 'External', description: '', lorebook: [] }
        const db = { modules: [target], enabledModules: [] }

        createImageStylePreset(db, 'Ink', 'ink', '', { moduleId: target.id })

        expect(target.lorebook[0]).toMatchObject({ comment: '프리셋 Ink' })
    })

    it('creates a lorebook folder only inside an existing selected module', () => {
        const target = { id: 'external', name: 'External', description: '', lorebook: [] }
        const db = { modules: [target] }

        const key = createImageStyleLorebookFolder(db, target.id, 'Styles')

        expect(key).toMatch(/^\uf000folder:/)
        expect(target.lorebook[0]).toMatchObject({ key, mode: 'folder', comment: 'Styles' })
        expect(createImageStyleLorebookFolder(db, 'missing', 'Ignored')).toBeUndefined()
    })

    it('supports placeholders used by third-party inlay modules', () => {
        expect(applyImageStylePreset(
            '[Positive]\nartist tag, {prompt}, {char}\n\n[Negative]\nlowres, {prompt}',
            '2girls, outdoors',
            'bad hands',
        )).toEqual({
            prompt: 'artist tag, 2girls, outdoors,',
            negativePrompt: 'lowres, bad hands',
        })
    })

    it('uses the secondary activation key as a stable ID', () => {
        const lorebook = {
            key: '',
            secondkey: '',
            insertorder: 1000,
            comment: '프리셋 Ink',
            content: '[Positive]\nink\n\n[Negative]\n',
            mode: 'normal' as const,
            alwaysActive: false,
            selective: false,
        }
        const module = { id: 'external', name: 'External', description: '', lorebook: [lorebook] }
        const db = { modules: [module] }

        const preset = listImageStylePresets(db)[0]
        lorebook.comment = '프리셋 Renamed'

        expect(lorebook.secondkey).toMatch(/^[0-9a-f-]{36}$/)
        expect(listImageStylePresets(db)[0].id).toBe(preset.id)
    })
})
