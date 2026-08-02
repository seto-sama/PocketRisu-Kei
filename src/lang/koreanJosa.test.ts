import { describe, expect, it } from 'vitest'
import { appendKoreanJosa, getKoreanJosa } from './koreanJosa'

describe('getKoreanJosa', () => {
    it('uses the exact Hangul jongseong, including the rieul exception', () => {
        expect(appendKoreanJosa('민수', '으로/로')).toBe('민수로')
        expect(appendKoreanJosa('민석', '으로/로')).toBe('민석으로')
        expect(appendKoreanJosa('서울', '으로/로')).toBe('서울로')
        expect(appendKoreanJosa('민석!', '으로/로')).toBe('민석!으로')
    })

    it('supports other common particle pairs', () => {
        expect(appendKoreanJosa('민수', '은/는')).toBe('민수는')
        expect(appendKoreanJosa('민석', '은/는')).toBe('민석은')
        expect(appendKoreanJosa('민수', '이/가')).toBe('민수가')
        expect(appendKoreanJosa('민석', '을/를')).toBe('민석을')
    })

    it('estimates English names and initialisms from their ending', () => {
        expect(appendKoreanJosa('John', '으로/로')).toBe('John으로')
        expect(appendKoreanJosa('Michael', '으로/로')).toBe('Michael로')
        expect(appendKoreanJosa('Alice', '으로/로')).toBe('Alice로')
        expect(appendKoreanJosa('Jane', '으로/로')).toBe('Jane으로')
        expect(appendKoreanJosa('GPT', '으로/로')).toBe('GPT로')
    })

    it('estimates Japanese names from the final kana', () => {
        expect(appendKoreanJosa('ミク', '으로/로')).toBe('ミク로')
        expect(appendKoreanJosa('リン', '으로/로')).toBe('リン으로')
        expect(appendKoreanJosa('りん', '으로/로')).toBe('りん으로')
        expect(appendKoreanJosa('太郎', '으로/로')).toBe('太郎로')
    })

    it('handles a final digit according to its Korean reading', () => {
        expect(getKoreanJosa('7', '으로/로')).toBe('로')
        expect(getKoreanJosa('10', '으로/로')).toBe('으로')
    })
})
