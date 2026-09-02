import { afterEach, describe, expect, it, vi } from 'vitest'
import { observeWithinChatViewport } from './chatViewportObserver'

describe('chatViewportObserver', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('shares an observer for persistent theme and one-shot inlay consumers', () => {
        let observerCallback: IntersectionObserverCallback | undefined
        const observe = vi.fn()
        const unobserve = vi.fn()
        const disconnect = vi.fn()
        const IntersectionObserverMock = vi.fn(function (
            callback: IntersectionObserverCallback,
            _options?: IntersectionObserverInit,
        ) {
            observerCallback = callback
            return { observe, unobserve, disconnect }
        })
        vi.stubGlobal('IntersectionObserver', IntersectionObserverMock)

        const root = document.createElement('div')
        Object.defineProperty(root, 'clientHeight', { value: 600 })
        root.dataset.chatScrollRoot = ''
        const themeTarget = document.createElement('div')
        const inlayTarget = document.createElement('div')
        root.append(themeTarget, inlayTarget)
        const themeCallback = vi.fn()
        const inlayCallback = vi.fn()
        const stopTheme = observeWithinChatViewport([themeTarget], themeCallback, { once: false })
        const stopInlay = observeWithinChatViewport([inlayTarget], inlayCallback)

        expect(IntersectionObserverMock).toHaveBeenCalledTimes(1)
        expect(IntersectionObserverMock.mock.calls[0][1]).toMatchObject({
            root,
            rootMargin: '600px 0px',
        })

        observerCallback?.([{
            target: themeTarget,
            isIntersecting: false,
        } as unknown as IntersectionObserverEntry, {
            target: inlayTarget,
            isIntersecting: false,
        } as unknown as IntersectionObserverEntry], {} as IntersectionObserver)
        expect(themeCallback).toHaveBeenCalledWith(themeTarget, false)
        expect(inlayCallback).not.toHaveBeenCalled()

        observerCallback?.([{
            target: themeTarget,
            isIntersecting: true,
        } as unknown as IntersectionObserverEntry, {
            target: inlayTarget,
            isIntersecting: true,
        } as unknown as IntersectionObserverEntry], {} as IntersectionObserver)
        expect(themeCallback).toHaveBeenLastCalledWith(themeTarget, true)
        expect(inlayCallback).toHaveBeenCalledTimes(1)
        expect(unobserve).toHaveBeenCalledWith(inlayTarget)

        stopInlay()
        stopTheme()
        expect(disconnect).toHaveBeenCalledTimes(1)
    })

    it('releases the shared observer after its last one-shot subscription fires', () => {
        let observerCallback: IntersectionObserverCallback | undefined
        const disconnect = vi.fn()
        vi.stubGlobal('IntersectionObserver', vi.fn(function (
            callback: IntersectionObserverCallback,
        ) {
            observerCallback = callback
            return { observe: vi.fn(), unobserve: vi.fn(), disconnect }
        }))

        const root = document.createElement('div')
        root.dataset.chatScrollRoot = ''
        const target = document.createElement('div')
        root.append(target)
        const callback = vi.fn()
        observeWithinChatViewport([target], callback)

        observerCallback?.([{
            target,
            isIntersecting: true,
        } as unknown as IntersectionObserverEntry], {} as IntersectionObserver)

        expect(callback).toHaveBeenCalledOnce()
        expect(disconnect).toHaveBeenCalledOnce()
    })
})
