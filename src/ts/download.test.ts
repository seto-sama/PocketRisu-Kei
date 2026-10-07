import { afterEach, expect, it, vi } from 'vitest'
import { downloadFile } from './download'

afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
})

it('downloads UTF-8 text and binary slices with deferred object URL cleanup', async () => {
    vi.useFakeTimers()
    const blobs: Blob[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
        blobs.push(blob as Blob)
        return `blob:download-${blobs.length}`
    })
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const names: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
        names.push(this.download)
    })

    await downloadFile('프리셋.json', '{"name":"한글 🌸"}')
    await downloadFile('image.bin', Uint8Array.of(99, 0, 255, 99).subarray(1, 3))
    expect(await blobs[0].text()).toBe('{"name":"한글 🌸"}')
    expect(new Uint8Array(await blobs[1].arrayBuffer())).toEqual(Uint8Array.of(0, 255))
    expect(names).toEqual(['프리셋.json', 'image.bin'])
    expect(revoke).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(revoke.mock.calls).toEqual([['blob:download-1'], ['blob:download-2']])
})
