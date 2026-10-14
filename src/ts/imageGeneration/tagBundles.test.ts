import { expect, it } from 'vitest'
import type { RisuModule } from '../process/modules'
import type { loreBook } from '../storage/database.svelte'
import { createImageStylePreset } from './stylePresets'
import {
    expandImageTagBundles,
    getImageTagBundleLorebook,
    listImageTagBundles,
    saveImageTagBundleLorebook,
} from './tagBundles'

function book(comment: string, content: string): loreBook {
    return { comment, content, key: '', secondkey: '', mode: 'normal', insertorder: 1000, alwaysActive: false, selective: false }
}

it('reads character and UUID-bound module sections, resolving only char/user and preferring character names', () => {
    const content = "## Character Image Tags\r\nIntroduction\r\n\r\n### {{char}}'s tags\r\n\r\nboy, {{{tan skin}}}, {{user}}, {{getvar::outfit}}\r\n\r\n### Hatsune Miku\r\npriest\r\n### Empty\r\n"
    const db = { username: 'Test User', modules: [{ id: 'module', name: 'Illustration', description: '', lorebook: [
        book('캐릭터 프리셋', '### Unbound\nignored'),
        book('Other', '### Ignored\nignored'),
    ] }] }
    saveImageTagBundleLorebook(db, "### miku's tags\nignored\n### Black Suit\nblack suit, red necktie", 'module')
    getImageTagBundleLorebook(db, 'module')!.comment = 'Renamed outfits'
    const current = { name: 'Hatsune Miku', nickname: 'Miku', globalLore: [book('lb-xnai.lb.extra', content)] }
    const bundles = listImageTagBundles(db, current)
    expect(bundles.map(bundle => [bundle.name, bundle.source])).toEqual([
        ["Miku's tags", 'Hatsune Miku'], ['Hatsune Miku', 'Hatsune Miku'], ['Black Suit', 'Illustration'],
    ])
    expect(bundles[0].content).toBe('boy, {{{tan skin}}}, Test User, {{getvar::outfit}}')
    expect(current.globalLore[0].content).toBe(content)
})

it('expands multiple references inside weight wrappers while preserving unknown names', () => {
    const bundles = [
        { name: 'Miku', content: 'boy, {{{tan skin}}}', source: 'Hatsune Miku' },
        { name: 'Black Suit', content: 'black suit, red necktie', source: 'Character' },
    ]
    const prompt = '{{{### Miku}}}, 1.3::### Black Suit:: | (### Miku:0.8), ### Miku Junior, #### Miku'
    expect(expandImageTagBundles(prompt, bundles)).toEqual({
        prompt: '{{{boy, {{{tan skin}}}}}}, 1.3::black suit, red necktie:: | (boy, {{{tan skin}}}:0.8), ### Miku Junior, #### Miku',
        bundleNames: ['Miku', 'Black Suit'],
    })
})

it('stores an inactive bundle lorebook with a stable UUID and keeps editing it after rename', () => {
    const moduleId = 'illustration'
    const db: { modules: RisuModule[] } = { modules: [{ id: moduleId, name: 'Illustration', description: '', lorebook: [] }] }
    createImageStylePreset(db, 'Ink', 'ink', '', { moduleId })
    const originalStyle = structuredClone(db.modules[0].lorebook![0])
    saveImageTagBundleLorebook(db, '### Miku\nboy', moduleId)
    expect(db.modules).toHaveLength(1)
    const bundleBook = getImageTagBundleLorebook(db, moduleId)!
    const id = db.modules[0].imageTagBundleLorebookId
    expect(id).toBeTruthy()
    expect(bundleBook).toMatchObject({
        key: '', alwaysActive: false, content: '### Miku\nboy',
        extentions: { risu_imageTagBundleId: id },
    })
    bundleBook.comment = 'Renamed characters'
    saveImageTagBundleLorebook(db, '### Black Suit\nblack suit', moduleId)
    expect(db.modules[0].lorebook).toHaveLength(2)
    expect(db.modules[0].lorebook![0]).toEqual(originalStyle)
    expect(db.modules[0].imageTagBundleLorebookId).toBe(id)
    expect(getImageTagBundleLorebook(db, moduleId)).toMatchObject({ comment: 'Renamed characters', content: '### Black Suit\nblack suit' })
})
