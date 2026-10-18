const OBJECT_URL_REVOKE_DELAY_MS = 10_000

/** Starts a browser download; returning does not mean the transfer has finished. */
export function downloadUrl(url: string, name = ''): void {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    try {
        anchor.click()
    } finally {
        anchor.remove()
    }
}

export async function downloadFile(name: string, data: Uint8Array | ArrayBuffer | Blob | string): Promise<void> {
    const blob = new Blob([data as BlobPart], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    try {
        downloadUrl(url, name)
    } finally {
        // Give the browser time to consume the object URL after the click.
        setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_REVOKE_DELAY_MS)
    }
}
