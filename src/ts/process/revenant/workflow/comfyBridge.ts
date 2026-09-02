import { getCurrentImageGenerationPreset } from '../../../imageGeneration/presets'
import { getDatabase } from '../../../storage/database.svelte'
import {
    createRevenantGenerationAuth,
    getRevenantGenerationSyncClientId,
} from '../transport/client'
import { getComfyBridgeId } from './comfyBridgeId'

const HANDLE_KEY = 'risu-comfy-bridge-handles'
const MAX_STORED_HANDLES = 32
const MAX_RESULT_BYTES = 64 * 1024 * 1024

export interface ComfyBridgeJobStatus {
    provider?: string
    status?: 'queued' | 'waiting_client' | 'generating' | 'completed' | 'failed' | 'interrupted'
    bridgeRequest?: { prompt: string, negativePrompt: string, seed: number }
    bridgeId?: string
    providerHandle?: { promptId: string, clientId: string }
}

type StoredHandle = { promptId: string, clientId: string }
const running = new Map<string, Promise<void>>()
function randomId(): string {
    return globalThis.crypto?.randomUUID?.()
        ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function readHandles(): Record<string, StoredHandle> {
    try {
        const value = JSON.parse(globalThis.localStorage?.getItem(HANDLE_KEY) ?? '{}')
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    } catch { return {} }
}

function writeHandle(jobId: string, handle?: StoredHandle): void {
    try {
        const handles = readHandles()
        if (handle) handles[jobId] = handle
        else delete handles[jobId]
        while (Object.keys(handles).length > MAX_STORED_HANDLES) {
            delete handles[Object.keys(handles)[0]]
        }
        globalThis.localStorage?.setItem(HANDLE_KEY, JSON.stringify(handles))
    } catch {}
}

function createComfyUrl(base: string, path: string, query?: Record<string, string>): URL {
    const root = new URL(base)
    if (!['http:', 'https:'].includes(root.protocol)) throw new Error('Invalid local ComfyUI URL')
    const url = base.endsWith('/api') ? new URL(`${base}${path}`) : new URL(path, root)
    if (query) url.search = new URLSearchParams(query).toString()
    return url
}

async function directFetch(url: URL, init: {
    method: 'GET' | 'POST'
    body?: string
    headers?: Record<string, string>
    requestTimeoutMs?: number
}): Promise<Response> {
    const controller = new AbortController()
    const timer = init.requestTimeoutMs
        ? setTimeout(() => controller.abort(), init.requestTimeoutMs)
        : undefined
    try {
        return await fetch(url, {
            method: init.method,
            body: init.body,
            headers: init.headers,
            signal: controller.signal,
        })
    } finally {
        if (timer) clearTimeout(timer)
    }
}

function buildWorkflow(raw: string, request: NonNullable<ComfyBridgeJobStatus['bridgeRequest']>) {
    const workflow = JSON.parse(raw) as Record<string, { inputs?: Record<string, unknown> }>
    if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
        throw new Error('Invalid local ComfyUI workflow')
    }
    for (const node of Object.values(workflow)) {
        if (!node?.inputs || typeof node.inputs !== 'object' || Array.isArray(node.inputs)) continue
        for (const key of Object.keys(node.inputs)) {
            let input = node.inputs[key]
            if (typeof input === 'string') {
                input = input.replaceAll('{{risu_prompt}}', request.prompt)
                    .replaceAll('{{risu_neg}}', request.negativePrompt)
            }
            if (key === 'seed' && typeof input === 'number') input = request.seed
            node.inputs[key] = input
        }
    }
    return workflow
}

async function nodeMutation(
    jobId: string,
    operation: 'submitted' | 'progress' | 'complete' | 'fail',
    body: Record<string, unknown>,
) {
    const response = await fetch(
        `/api/image-generation/jobs/${encodeURIComponent(jobId)}/comfy/${operation}`,
        {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'risu-auth': await createRevenantGenerationAuth(),
                'x-sync-client-id': getRevenantGenerationSyncClientId(),
            },
            body: JSON.stringify({ bridgeId: getComfyBridgeId(), ...body }),
        },
    )
    const result = await response.json().catch(() => ({})) as { error?: string }
    if (!response.ok) throw new Error(result.error || `ComfyUI bridge update failed: ${response.status}`)
}

function openProgressSocket(baseUrl: string, handle: StoredHandle, jobId: string): WebSocket | undefined {
    try {
        const url = createComfyUrl(baseUrl, '/ws', { clientId: handle.clientId })
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
        const socket = new WebSocket(url)
        let lastReport = 0
        socket.onmessage = event => {
            try {
                const message = JSON.parse(String(event.data))
                const data = message?.data
                if (message?.type !== 'progress' || data?.prompt_id !== handle.promptId) return
                const now = Date.now()
                if (now - lastReport < 250) return
                lastReport = now
                void nodeMutation(jobId, 'progress', {
                    promptId: handle.promptId,
                    value: Number(data.value),
                    max: Number(data.max),
                    node: data.node,
                }).catch(() => {})
            } catch {}
        }
        socket.onerror = () => socket.close()
        return socket
    } catch { return undefined }
}

async function execute(jobId: string, initial: ComfyBridgeJobStatus): Promise<void> {
    if (initial.provider !== 'comfyui' || !initial.bridgeRequest) return
    if (initial.bridgeId !== getComfyBridgeId()) return
    const preset = getCurrentImageGenerationPreset(getDatabase()).settings
    if (preset.sdProvider !== 'comfyui') throw new Error('The local image preset is not ComfyUI')
    const baseUrl = preset.comfyUiUrl
    const timeoutMs = Math.max(1, Math.min(600, Number(preset.comfyConfig?.timeout) || 120)) * 1000
    let handle = initial.providerHandle ?? readHandles()[jobId]
    if (!handle) {
        const workflow = buildWorkflow(preset.comfyConfig?.workflow || '', initial.bridgeRequest)
        const clientId = `risu-${randomId()}`
        const response = await directFetch(createComfyUrl(baseUrl, '/prompt'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: workflow, client_id: clientId }),
            requestTimeoutMs: timeoutMs,
        })
        const body = await response.json().catch(() => ({})) as { prompt_id?: string, error?: unknown }
        if (!response.ok || !body.prompt_id) {
            throw new Error(typeof body.error === 'string' ? body.error : `ComfyUI prompt failed: ${response.status}`)
        }
        handle = { promptId: body.prompt_id, clientId }
        // Persist before notifying Node. A reload in this narrow interval can
        // recover the existing Comfy prompt instead of submitting a duplicate.
        writeHandle(jobId, handle)
    }
    await nodeMutation(jobId, 'submitted', handle)
    const socket = openProgressSocket(baseUrl, handle, jobId)
    try {
        const deadline = Date.now() + timeoutMs
        let item: any
        while (!item) {
            if (Date.now() >= deadline) throw new Error('ComfyUI image generation timed out')
            const response = await directFetch(createComfyUrl(baseUrl, '/history'), {
                method: 'GET',
                headers: { 'content-type': 'application/json' },
                requestTimeoutMs: Math.min(timeoutMs, 30_000),
            })
            if (!response.ok) throw new Error(`ComfyUI history failed: ${response.status}`)
            const history = await response.json() as Record<string, unknown>
            item = history[handle.promptId]
            if (!item) await new Promise(resolve => setTimeout(resolve, 1000))
        }
        const failure = [...(item?.status?.messages || [])].reverse().find((entry: unknown) =>
            Array.isArray(entry) && ['execution_error', 'execution_interrupted'].includes(entry[0]))
        if (failure || ['error', 'failed'].includes(item?.status?.status_str)) {
            throw new Error(JSON.stringify((failure as any)?.[1] || item?.status || 'ComfyUI generation failed'))
        }
        const output = Object.values(item.outputs || {})
            .flatMap((value: any) => Array.isArray(value?.images) ? value.images : [])
            .find((image: any) => image && typeof image.filename === 'string') as any
        if (!output) throw new Error('ComfyUI completed without an image output')
        const response = await directFetch(createComfyUrl(baseUrl, '/view', {
            filename: output.filename,
            subfolder: output.subfolder || '',
            type: output.type || 'output',
        }), { method: 'GET', requestTimeoutMs: Math.min(timeoutMs, 30_000) })
        if (!response.ok) throw new Error(`ComfyUI image download failed: ${response.status}`)
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (!bytes.length || bytes.length > MAX_RESULT_BYTES) {
            throw new Error('ComfyUI image result is too large')
        }
        let binary = ''
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
        }
        const contentType = response.headers.get('content-type') || ''
        const resultFormat = contentType.includes('webp') ? 'webp'
            : contentType.includes('jpeg') ? 'jpeg' : 'png'
        await nodeMutation(jobId, 'complete', {
            promptId: handle.promptId,
            resultBase64: btoa(binary),
            resultFormat,
        })
        writeHandle(jobId)
    } finally {
        socket?.close()
    }
}

export function serviceComfyBridgeJob(jobId: string, job: ComfyBridgeJobStatus): Promise<void> {
    const active = running.get(jobId)
    if (active) return active
    const task = execute(jobId, job)
        .catch(async error => {
            try {
                await nodeMutation(jobId, 'fail', {
                    error: error instanceof Error ? error.message : String(error),
                })
            } catch {}
            throw error
        })
        .finally(() => running.delete(jobId))
    running.set(jobId, task)
    return task
}
