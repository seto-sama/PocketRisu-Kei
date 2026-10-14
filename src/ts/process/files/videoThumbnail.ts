import { getInlayThumbnailScale } from '../../../../shared/inlayTypes.mjs'

export function createVideoThumbnail(source: Blob): Promise<Blob | null> {
    return new Promise(resolve => {
        const video = document.createElement('video')
        const url = URL.createObjectURL(source)
        let settled = false
        let capturing = false
        let waitingForSeek = false

        const finish = (blob: Blob | null) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            video.onloadedmetadata = video.onloadeddata = video.oncanplay = video.onseeked = video.onerror = null
            video.pause()
            video.removeAttribute('src')
            video.load()
            URL.revokeObjectURL(url)
            resolve(blob)
        }
        const timeout = setTimeout(() => finish(null), 10_000)
        const capture = () => {
            if (capturing || waitingForSeek || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
                || !video.videoWidth || !video.videoHeight) return
            capturing = true
            try {
                const canvas = document.createElement('canvas')
                const scale = getInlayThumbnailScale(video.videoWidth, video.videoHeight)
                canvas.width = Math.max(1, Math.floor(video.videoWidth * scale))
                canvas.height = Math.max(1, Math.floor(video.videoHeight * scale))
                const context = canvas.getContext('2d')
                if (!context) return finish(null)
                context.drawImage(video, 0, 0, canvas.width, canvas.height)
                canvas.toBlob(finish, 'image/png')
            } catch {
                finish(null)
            }
        }

        video.muted = true
        video.playsInline = true
        video.preload = 'auto'
        video.onloadedmetadata = () => {
            const time = Number.isFinite(video.duration) ? Math.min(0.1, video.duration / 2) : 0
            if (time > 0) {
                waitingForSeek = true
                try { video.currentTime = time } catch { finish(null) }
            }
        }
        video.onseeked = () => { waitingForSeek = false; capture() }
        video.onloadeddata = video.oncanplay = capture
        video.onerror = () => finish(null)
        video.src = url
        video.load()
    })
}
