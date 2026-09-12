// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import CBSDocumentationDialog from './CBSDocumentationDialog.svelte'
import { getCBSDocumentation } from 'src/ts/cbsDocumentation'

vi.mock('src/ts/parser/parser.svelte', () => ({
    parseMarkdownSafe: (text:string) => text,
}))

vi.mock('src/ts/cbsDocumentation', () => ({
    getCBSDocumentation: vi.fn(() => []),
}))

let component:unknown

afterEach(async () => {
    if(component) await unmount(component as never)
    component = undefined
    document.body.replaceChildren()
})

describe('CBS documentation dialog', () => {
    test('loads documentation and closes through the shared dialog control', async () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        component = mount(CBSDocumentationDialog, {
            target,
            props: { open: true },
        })
        await tick()

        expect(getCBSDocumentation).toHaveBeenCalledOnce()
        expect(document.querySelector('[role="dialog"] input')).not.toBeNull()

        document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click()
        await tick()

        expect(document.querySelector('[role="dialog"]')?.getAttribute('data-state')).toBe('closed')
    })
})
