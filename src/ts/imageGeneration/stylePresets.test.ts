import { describe, expect, it } from 'vitest'
import {
    IMAGE_STYLE_PRESET_MODULE_NAMESPACE,
    applyImageStylePreset,
    applyImageStylePresetBinding,
    createImageStylePreset,
    createImageStyleLorebookFolder,
    formatImageStylePresetContent,
    parseImageStylePresetContent,
    listImageStylePresets,
    loadImageStylePresets,
} from './stylePresets'

describe('image style presets', () => {
    it('creates compatible module lorebooks', () => {
        const db = { modules: [] }
        const preset = createImageStylePreset(db, '수채화', 'watercolor', 'photo')
        const module = db.modules[0]
        const lorebook = module.lorebook![0]

        expect(module.namespace).toBe(IMAGE_STYLE_PRESET_MODULE_NAMESPACE)
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

    it('stores and parses an image generation preset binding without leaking it into prompts', () => {
        const db = { modules: [] }
        const preset = createImageStylePreset(db, 'Ink', 'ink', 'photo', {
            imageGenerationPresetId: 'generation-preset-uuid',
        })

        expect(preset.content).toBe(
            '[Binding]\ngeneration-preset-uuid\n\n[Positive]\nink\n\n[Negative]\nphoto',
        )
        expect(parseImageStylePresetContent(preset.content)).toEqual({
            preamble: '',
            positive: 'ink',
            negative: 'photo',
            imageGenerationPresetId: 'generation-preset-uuid',
        })
        expect(applyImageStylePreset(preset.content, 'portrait', 'blurry')).toEqual({
            prompt: 'ink,\nportrait',
            negativePrompt: 'photo,\nblurry',
        })

        expect(parseImageStylePresetContent(
            '[Positive]\nink\n\n[Negative]\nphoto\n\n[Binding]\ngeneration-preset-uuid',
        ).imageGenerationPresetId).toBe('')
    })

    it('preserves preset preamble and places Binding directly before Positive', () => {
        const original = '라이트보드 NAI 프리셋1\n\n[Positive]\nink\n\n[Negative]\nphoto'
        const parsed = parseImageStylePresetContent(original)
        const saved = formatImageStylePresetContent(
            parsed.positive,
            parsed.negative,
            'generation-preset-uuid',
            parsed.preamble,
        )

        expect(saved).toBe(
            '라이트보드 NAI 프리셋1\n\n[Binding]\ngeneration-preset-uuid\n\n[Positive]\nink\n\n[Negative]\nphoto',
        )
        expect(parseImageStylePresetContent(saved)).toEqual({
            preamble: '라이트보드 NAI 프리셋1',
            positive: 'ink',
            negative: 'photo',
            imageGenerationPresetId: 'generation-preset-uuid',
        })
    })

    it('selects a bound generation preset by stable UUID and ignores stale bindings', () => {
        const db = {
            imageGenerationPresets: [{ id: 'first' }, { id: 'bound-id' }],
            imageGenerationPresetId: 0,
        }

        expect(applyImageStylePresetBinding(
            db,
            '[Binding]\nbound-id\n\n[Positive]\nink\n\n[Negative]\nphoto',
        )).toBe(true)
        expect(db.imageGenerationPresetId).toBe(1)
        expect(applyImageStylePresetBinding(
            db,
            '[Binding]\ndeleted-id\n\n[Positive]\nink\n\n[Negative]\nphoto',
        )).toBe(false)
        expect(db.imageGenerationPresetId).toBe(1)
    })

    it('creates presets inside a selected module', () => {
        const target = { id: 'external', name: 'External', description: '', lorebook: [] }
        const db = { modules: [target] }

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

    it('ensures a missing secondary key before listing and keeps the preset ID stable', () => {
        const lorebook = {
            key: '',
            secondkey: ' \t ',
            insertorder: 1000,
            comment: '프리셋 Ink',
            content: '[Positive]\nink\n\n[Negative]\n',
            mode: 'normal' as const,
            alwaysActive: false,
            selective: false,
        }
        const module = { id: 'external', name: 'External', description: '', lorebook: [lorebook] }
        const db = { modules: [module] }

        const preset = loadImageStylePresets(db)[0]
        expect(lorebook.secondkey).toMatch(/^[0-9a-f-]{36}$/)
        lorebook.comment = '프리셋 Renamed'

        expect(loadImageStylePresets(db)[0].id).toBe(preset.id)
    })

    it('allows the same secondary key across modules and rejects duplicates within a module', () => {
        const db = { modules: [] }
        createImageStylePreset(db, 'First', 'ink', '')
        const first = db.modules[0]
        first.lorebook[0].secondkey = '006'
        const second = { ...first, id: 'second', lorebook: structuredClone(first.lorebook) }
        db.modules.push(second)

        const presets = loadImageStylePresets(db)
        expect(presets).toHaveLength(2)
        expect(presets[0].id).not.toBe(presets[1].id)
        expect(second.lorebook[0].secondkey).toBe('006')

        first.lorebook.push({ ...first.lorebook[0], secondkey: ' 006 ' })
        expect(() => loadImageStylePresets(db)).toThrow('Duplicate entity ID: 006')
        expect(first.lorebook[1].secondkey).toBe(' 006 ')
    })

    it('preserves ordinary lorebooks and secondary keys used by search conditions', () => {
        const db = { modules: [] }
        createImageStylePreset(db, 'Ink', 'ink', '')
        const module = db.modules[0]
        const style = module.lorebook[0]
        const otherLorebooks = [
            { ...style, comment: 'Ordinary lorebook', secondkey: '' },
            { ...style, key: 'trigger', secondkey: '' },
            { ...style, selective: true, secondkey: ' condition ' },
            { ...style, alwaysActive: true, secondkey: '' },
        ]
        const before = structuredClone(otherLorebooks)
        module.lorebook.push(...otherLorebooks)

        loadImageStylePresets(db)

        expect(otherLorebooks).toEqual(before)
    })
})
