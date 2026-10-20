import { afterEach, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import { DBState } from 'src/ts/stores.svelte'
import SettingCheck from './SettingCheck.svelte'

let component: ReturnType<typeof mount> | undefined
const previousHidden = DBState.db.hidePublicStats

afterEach(async () => {
    if (component) await unmount(component)
    component = undefined
    document.body.replaceChildren()
    DBState.db.hidePublicStats = previousHidden
})

it.each([false, true])('updates the stored setting and callback when reverse=%s', async (reverse) => {
    DBState.db.hidePublicStats = false
    const target = document.createElement('div')
    document.body.appendChild(target)
    const onChange = vi.fn()
    component = mount(SettingCheck, {
        target,
        props: {
            item: { id: 'statistics', type: 'check', bindKey: 'hidePublicStats', options: { reverse }, onChange },
            ctx: { db: DBState.db },
        },
    })
    await tick()

    const control = target.querySelector<HTMLButtonElement>('[role="switch"]')!
    expect(control.getAttribute('aria-checked')).toBe(String(reverse))
    expect(onChange).not.toHaveBeenCalled()

    control.click()
    await tick()
    expect(DBState.db.hidePublicStats).toBe(true)
    expect(onChange).toHaveBeenCalledExactlyOnceWith(true, expect.objectContaining({ db: DBState.db }))
    expect(control.getAttribute('aria-checked')).toBe(String(!reverse))

    DBState.db.hidePublicStats = false
    await tick()
    expect(control.getAttribute('aria-checked')).toBe(String(reverse))
    expect(onChange).toHaveBeenCalledTimes(1)
})
