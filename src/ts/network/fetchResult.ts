export async function readGlobalFetchResponse(response: Response, rawResponse = false) {
    const headers = Object.fromEntries(response.headers.entries())
    const status = response.status
    if (rawResponse) {
        return { ok: response.ok, data: new Uint8Array(await response.arrayBuffer()), headers, status }
    }
    const text = await response.text()
    try {
        return { ok: response.ok, data: JSON.parse(text), headers, status }
    } catch {
        const data = text.startsWith('<!DOCTYPE')
            ? 'Responded HTML. Is your URL, API key, and password correct?'
            : text
        return { ok: false, data, headers, status }
    }
}
