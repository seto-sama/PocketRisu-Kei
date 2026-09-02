// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import {
    getRenderedTextForLanguageDetection,
    isRenderedTextLikelyDifferentFromUiLanguage,
    isTextLikelyDifferentFromUiLanguage,
} from './textLanguage'

describe('isTextLikelyDifferentFromUiLanguage', () => {
    it('compares Korean and Latin messages with the Korean UI', () => {
        expect(isTextLikelyDifferentFromUiLanguage('안녕하세요! 오늘은 좋은 날이에요.', 'ko')).toBe(false)
        expect(isTextLikelyDifferentFromUiLanguage('Hello! Today is a lovely day.', 'ko')).toBe(true)
    })

    it('uses the dominant script for mixed messages', () => {
        expect(isTextLikelyDifferentFromUiLanguage('한국어 문장이 더 깁니다. OK', 'ko')).toBe(false)
        expect(isTextLikelyDifferentFromUiLanguage('This sentence is mostly English. 한글', 'ko')).toBe(true)
    })

    it('treats simplified and traditional Chinese UI languages as Han script', () => {
        expect(isTextLikelyDifferentFromUiLanguage('你好，今天过得怎么样？', 'cn')).toBe(false)
        expect(isTextLikelyDifferentFromUiLanguage('您好，今天過得怎麼樣？', 'zh-Hant')).toBe(false)
        expect(isTextLikelyDifferentFromUiLanguage('오늘은 어때요?', 'cn')).toBe(true)
    })

    it('does not trigger on text without a detectable script', () => {
        expect(isTextLikelyDifferentFromUiLanguage('1234 🎉 !!!', 'ko')).toBe(false)
    })

    it('excludes chain-of-thought blocks from the dominant-script decision', () => {
        expect(isTextLikelyDifferentFromUiLanguage(
            '<Thoughts>한국어로 작성된 아주 길고 자세한 생각의 사슬입니다.</Thoughts>Hello!',
            'ko',
        )).toBe(true)
        expect(isTextLikelyDifferentFromUiLanguage(
            '<Thoughts>A very long chain of thought written entirely in English.</Thoughts>안녕하세요!',
            'ko',
        )).toBe(false)
        expect(isTextLikelyDifferentFromUiLanguage(
            '<think>English provider reasoning that must be ignored.</think>반가워요!',
            'ko',
        )).toBe(false)
    })

    it('ignores an unfinished displayed chain-of-thought block', () => {
        expect(isTextLikelyDifferentFromUiLanguage(
            '<Thoughts>This streaming reasoning is not closed yet.',
            'ko',
        )).toBe(false)
    })

    it('excludes CBS tokens, including nested tokens, from the decision', () => {
        expect(isTextLikelyDifferentFromUiLanguage(
            '{{inlayed::english-image-name}}안녕하세요!',
            'ko',
        )).toBe(false)
        expect(isTextLikelyDifferentFromUiLanguage(
            '{{join::{{inlayed::english-image-name}}::English separator}}반가워요!',
            'ko',
        )).toBe(false)
        expect(isTextLikelyDifferentFromUiLanguage(
            '{{inlayed::한국어-이미지-이름}}Hello!',
            'ko',
        )).toBe(true)
    })

    it('removes CBS block markers but keeps their visible body text', () => {
        expect(isTextLikelyDifferentFromUiLanguage(
            '{{#when::1::is::1}}Visible English response{{/when}}',
            'ko',
        )).toBe(true)
    })

    it('uses only visible final HTML text and excludes images and parsed thoughts', () => {
        const rendered = [
            '<details class="x-risu-thoughts"><summary>Chain of thought</summary>',
            'A very long English reasoning section that must not affect detection.',
            '</details>',
            '<img src="english-status-panel.png" alt="Date Location Weather Status">',
            '<p>안녕하세요. 오늘도 반가워요.</p>',
        ].join('')

        expect(getRenderedTextForLanguageDetection(rendered)).toContain('안녕하세요')
        expect(getRenderedTextForLanguageDetection(rendered)).not.toContain('reasoning')
        expect(getRenderedTextForLanguageDetection(rendered)).not.toContain('Date')
        expect(isRenderedTextLikelyDifferentFromUiLanguage(rendered, 'ko')).toBe(false)
    })
})
