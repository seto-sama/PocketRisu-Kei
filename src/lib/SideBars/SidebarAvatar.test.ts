// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import SidebarAvatar from './SidebarAvatar.svelte'

vi.mock('src/ts/gui/tooltip', () => ({
    tooltipRight: () => ({ update() {}, destroy() {} }),
}))

const mountedComponents: unknown[] = []

async function renderFolder(backgroundimg = '', selected = false) {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const component = mount(SidebarAvatar, {
        target,
        props: {
            src: 'slot',
            size: '56',
            rounded: false,
            bordered: true,
            name: 'Folder',
            color: 'blue',
            backgroundimg,
            selected,
        },
    })
    mountedComponents.push(component)
    await tick()
    return target.querySelector<HTMLElement>('.avatar')!
}

afterEach(async () => {
    await Promise.all(mountedComponents.splice(0).map(component => unmount(component as never)))
    document.body.replaceChildren()
})

describe('SidebarAvatar folder borders', () => {
    it('keeps the default SVG border inside the fixed folder size', async () => {
        const avatar = await renderFolder()
        const tile = avatar.querySelector<HTMLElement>('.folder-avatar-tile')!
        const border = avatar.querySelector<HTMLElement>('.avatar-border-overlay')!

        expect(avatar.classList.contains('avatar-state-border')).toBe(true)
        expect(avatar.classList.contains('border')).toBe(false)
        expect(tile.style.width).toBe('56px')
        expect(tile.style.height).toBe('56px')
        expect(tile.classList.contains('border')).toBe(false)
        expect(border.classList.contains('box-border')).toBe(true)
        expect(border.classList.contains('border')).toBe(true)
        expect(border.classList.contains('border-primary/40')).toBe(true)
        expect(border.classList.contains('border-transparent')).toBe(false)
    })

    it('keeps only the hover and selection border for a custom folder image', async () => {
        const avatar = await renderFolder('/folder.png')
        const tile = avatar.querySelector<HTMLElement>('.folder-avatar-tile')!
        const border = avatar.querySelector<HTMLElement>('.avatar-border-overlay')!

        expect(avatar.classList.contains('avatar-state-border')).toBe(true)
        expect(avatar.classList.contains('border')).toBe(false)
        expect(tile.style.width).toBe('56px')
        expect(tile.style.height).toBe('56px')
        expect(tile.classList.contains('border')).toBe(false)
        expect(border.classList.contains('box-border')).toBe(true)
        expect(border.classList.contains('border')).toBe(true)
        expect(border.classList.contains('border-transparent')).toBe(true)
        expect(border.classList.contains('border-primary/40')).toBe(false)
    })

    it.each([
        ['top-level', '56'],
        ['folder child', '48'],
    ])('overlays the %s character border without changing its %spx image', async (_location, size) => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(SidebarAvatar, {
            target,
            props: {
                src: '/character.png',
                size,
                rounded: false,
                name: 'Character',
            },
        })
        mountedComponents.push(component)
        await tick()

        const avatar = target.querySelector<HTMLElement>('.avatar')!
        const tile = avatar.querySelector<HTMLElement>('.avatar-tile')!
        const border = avatar.querySelector<HTMLElement>('.avatar-border-overlay')!
        expect(avatar.classList.contains('avatar-state-border')).toBe(true)
        expect(avatar.classList.contains('border')).toBe(false)
        expect(tile.style.width).toBe(`${size}px`)
        expect(tile.style.height).toBe(`${size}px`)
        expect(tile.classList.contains('border')).toBe(false)
        expect(border.classList.contains('box-border')).toBe(true)
        expect(border.classList.contains('border')).toBe(true)
        expect(border.classList.contains('border-transparent')).toBe(true)
    })

    it('adds rising particles only to a selected avatar', async () => {
        const unselectedAvatar = await renderFolder('/folder.png')
        const selectedAvatar = await renderFolder('/folder.png', true)

        expect(unselectedAvatar.querySelector('.avatar-selection-particles')).toBeNull()
        expect(selectedAvatar.querySelectorAll('.avatar-selection-particle')).toHaveLength(1)
    })

    it('uses the avatar overlay for a folder merge target', async () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(SidebarAvatar, {
            target,
            props: {
                src: '/character.png',
                size: '56',
                rounded: false,
                name: 'Merge target',
                mergeTarget: true,
            },
        })
        mountedComponents.push(component)
        await tick()

        const avatar = target.querySelector<HTMLElement>('.avatar')!
        expect(avatar.dataset.mergeTarget).toBe('true')
        expect(avatar.querySelector('.avatar-border-overlay')).not.toBeNull()
    })
})
