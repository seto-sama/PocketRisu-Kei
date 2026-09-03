import { describe, expect, it } from 'vitest'
import { applyCBSPreviewValues, extractCBSPreviewExpressions, extractCBSPreviewReferences } from './cbsPreview'

describe('CBS preview helpers', () => {
    it('collects unique leaf value expressions', () => {
        expect(extractCBSPreviewExpressions('{{char}} {{getvar::mood}} {{char}} <user>')).toEqual([
            '{{char}}',
            '{{user}}',
        ])
    })

    it('skips block controls and variable mutations', () => {
        expect(extractCBSPreviewExpressions(
            '{{#if condition}}{{setvar::mood::happy}}{{user}}{{/if}}',
        )).toEqual(['{{user}}'])
    })

    it('collects only the leaf expression from nested CBS', () => {
        expect(extractCBSPreviewReferences('{{#if {{getvar::enabled}}}}yes{{/if}}')).toEqual([
            { kind: 'chat', key: 'enabled' },
        ])
    })

    it('collects toggle and chat-variable references from #when conditions', () => {
        expect(extractCBSPreviewReferences(
            '{{#when::keep::Zag_Setting::tis::0}}yes{{:else}}no{{/when}} {{#when::mood::vis::happy}}ok{{/when}}',
        )).toEqual([
            { kind: 'toggle', key: 'Zag_Setting' },
            { kind: 'chat', key: 'mood' },
        ])
    })

    it('recognizes custom toggles read through getglobalvar', () => {
        expect(extractCBSPreviewReferences(
            '{{getglobalvar::toggle_TSUS_Preference}} {{getvar::mood}}',
        )).toEqual([
            { kind: 'toggle', key: 'TSUS_Preference' },
            { kind: 'chat', key: 'mood' },
        ])
    })

    it('recognizes non-toggle global variables separately', () => {
        expect(extractCBSPreviewReferences('{{getglobalvar::theme}}')).toEqual([
            { kind: 'global', key: 'theme' },
        ])
    })

    it('leaves CBS without preview metadata to the full parser', () => {
        expect(extractCBSPreviewReferences(
            '{{settempvar::mood::happy}}{{tempvar::mood}} {{random::a::b}}',
        )).toEqual([])
    })

    it('deduplicates the same toggle across direct reads and #when conditions', () => {
        expect(extractCBSPreviewReferences(
            '{{getglobalvar::toggle_TSUS_Preference}}{{#when::TSUS_Preference::tis::1}}yes{{/when}}',
        )).toEqual([
            { kind: 'toggle', key: 'TSUS_Preference' },
        ])
    })

    it('applies temporary values without changing the source map', () => {
        expect(applyCBSPreviewValues('{{user}} feels {{getvar::mood}}', [
            { expression: '{{user}}', value: 'Alice' },
            { expression: '{{getvar::mood}}', value: 'happy' },
        ])).toBe('Alice feels happy')
    })

    it('applies canonical name overrides to legacy aliases', () => {
        expect(applyCBSPreviewValues('<user> meets {{bot}} and <char>', [
            { expression: '{{user}}', value: 'Alice' },
            { expression: '{{char}}', value: 'Bob' },
        ])).toBe('Alice meets Bob and Bob')
    })
})
