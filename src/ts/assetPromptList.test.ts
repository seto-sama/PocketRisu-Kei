import { expect, it } from 'vitest'
import { formatAssetPromptList } from './assetPromptList'

it('lists characters and every keyword any of them has, keeping spaced names whole', () => {
    expect(formatAssetPromptList([
        'Ahn Do-hyun angry', 'Ahn Do-hyun happy', 'Ares_angry', 'Ares_happy', 'Ares_happy',
        'Zeus_crying with eyes closed', 'Zeus_angry', 'Kang Min-hyuk', 'Kang Min-hyuk angry', 'forest_bg',
    ])).toBe([
        'Format: <assets src="Character_Keyword"> (one character and one keyword)',
        'Characters: Ahn Do-hyun, Ares, Zeus, Kang Min-hyuk',
        'Keywords: angry, happy, crying with eyes closed',
        'Other images, used by name alone: Kang Min-hyuk, forest_bg',
        'Example: <assets src="Ahn Do-hyun angry">',
    ].join('\n'))
})

it('falls back to a plain image list when no names share a character', () => {
    expect(formatAssetPromptList(['sword', 'forest_bg'])).toBe([
        'Format: <assets src="Image Name">',
        'Images: sword, forest_bg',
        'Example: <assets src="sword">',
    ].join('\n'))
})
