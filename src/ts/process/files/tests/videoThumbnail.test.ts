import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createVideoThumbnail } from '../videoThumbnail'

let video: HTMLVideoElement
let canvas: HTMLCanvasElement
let readyState: number
const drawImage = vi.fn()

beforeEach(() => {
    vi.useFakeTimers()
    // happy-dom omits the standard media ready-state constants.
    vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 })
    readyState = 1
    video = document.createElement('video')
    canvas = document.createElement('canvas')
    Object.defineProperties(video, {
        duration: { value: 1 },
        readyState: { get: () => readyState },
        videoWidth: { value: 1920, configurable: true },
        videoHeight: { value: 1080, configurable: true },
    })
    vi.spyOn(video, 'load').mockImplementation(() => {})
    vi.spyOn(video, 'pause').mockImplementation(() => {})
    vi.spyOn(canvas, 'getContext').mockReturnValue({ drawImage } as any)
    vi.spyOn(canvas, 'toBlob').mockImplementation((callback, type) => callback(new Blob(['frame'], { type })))
    const createElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
        if (tag === 'video') return video
        if (tag === 'canvas') return canvas
        return createElement(tag)
    }) as typeof document.createElement)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:video-test')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    drawImage.mockClear()
})

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

test.each([
    [1920, 1080, 568, 320], [1080, 1920, 320, 568], [16, 8, 16, 8],
])('captures %sx%s video after seeking, without upscaling', async (width, height, outputWidth, outputHeight) => {
    Object.defineProperties(video, { videoWidth: { value: width }, videoHeight: { value: height } })
    const pending = createVideoThumbnail(new Blob(['video'], { type: 'video/mp4' }))
    video.dispatchEvent(new Event('loadedmetadata'))
    expect(video.currentTime).toBeGreaterThan(0)
    expect(video.currentTime).toBeLessThan(video.duration)
    readyState = 2
    video.dispatchEvent(new Event('loadeddata'))
    expect(drawImage).not.toHaveBeenCalled()
    video.dispatchEvent(new Event('seeked'))
    expect((await pending)?.type).toBe('image/png')
    expect(canvas.width).toBe(outputWidth)
    expect(canvas.height).toBe(outputHeight)
    expect(drawImage).toHaveBeenCalledOnce()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:video-test')
    expect(video.getAttribute('src')).toBeNull()
})

test.each(['error', 'timeout', 'encoding failure'])('returns no preview and releases video resources on %s', async failure => {
    const pending = createVideoThumbnail(new Blob(['video']))
    if (failure === 'timeout') await vi.runAllTimersAsync()
    else if (failure === 'error') video.dispatchEvent(new Event('error'))
    else {
        vi.spyOn(canvas, 'toBlob').mockImplementation(callback => callback(null))
        readyState = 2
        video.dispatchEvent(new Event('loadeddata'))
    }
    expect(await pending).toBeNull()
    expect(video.pause).toHaveBeenCalled()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:video-test')
})
