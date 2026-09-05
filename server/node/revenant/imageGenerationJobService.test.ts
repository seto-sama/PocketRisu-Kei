import { afterEach, describe, expect, it, vi } from 'vitest'
import { zipSync } from 'fflate'
import imageJobsPackage from './imageGenerationJobService.cjs'

const { installImageGenerationJobRoutes } = imageJobsPackage as {
    installImageGenerationJobRoutes: (app: any, deps: any) => {
        jobs: Map<string, any>
        abortWorkflow: (workflowId: string) => Promise<void>
        abortAll: () => void
        executeImageGeneration: (arg: any) => Promise<{ image: Buffer }>
    }
}

function responseRecorder() {
    return {
        statusCode: 200,
        body: undefined as any,
        status(code: number) { this.statusCode = code; return this },
        send(body: any) { this.body = body; return this },
    }
}

describe('Node image generation jobs', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('keeps one NovelAI request for repeated deterministic job IDs', async () => {
        const routes = new Map<string, Function>()
        const app = {
            post: (path: string, handler: Function) => routes.set(`POST ${path}`, handler),
            get: (path: string, handler: Function) => routes.set(`GET ${path}`, handler),
        }
        const upstream = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
        vi.stubGlobal('fetch', upstream)
        const service = installImageGenerationJobRoutes(app, {
            checkProxyAuth: async () => true,
            logger: { warn: vi.fn() },
        })
        const request = {
            query: { includeResult: '1' },
            body: {
                jobId: 'workflow-1:image-1',
                provider: 'novelai',
                spec: { apiKey: 'secret', body: { input: 'portrait' } },
            },
        }
        const first = responseRecorder()
        await routes.get('POST /api/image-generation/jobs')!(request, first)
        await service.jobs.get(request.body.jobId).runPromise

        const second = responseRecorder()
        await routes.get('POST /api/image-generation/jobs')!(request, second)

        expect(upstream).toHaveBeenCalledTimes(1)
        expect(second.body).toMatchObject({
            jobId: request.body.jobId,
            status: 'completed',
            resultBase64: 'AQID',
            resultFormat: 'novelai-zip',
        })
    })

    it('builds and unwraps a server-owned NovelAI image request', async () => {
        const routes = new Map<string, Function>()
        const app = {
            post: (path: string, handler: Function) => routes.set(`POST ${path}`, handler),
            get: (path: string, handler: Function) => routes.set(`GET ${path}`, handler),
        }
        const zipped = zipSync({ 'image.png': new Uint8Array([9, 8, 7]) })
        const upstream = vi.fn(async () => new Response(zipped, { status: 200 }))
        vi.stubGlobal('fetch', upstream)
        const service = installImageGenerationJobRoutes(app, {
            checkProxyAuth: async () => true,
            logger: { warn: vi.fn() },
        })

        const result = await service.executeImageGeneration({
            jobId: 'workflow:image',
            settings: {
                sdProvider: 'novelai',
                NAIImgModel: 'nai-diffusion-3',
                NAIImgConfig: { width: 832, height: 1216, steps: 28 },
                NAII2I: false,
            },
            apiKey: 'secret',
            prompt: 'portrait',
            negativePrompt: 'blur',
            seed: 42,
        })

        expect([...result.image]).toEqual([9, 8, 7])
        const request = JSON.parse(String((upstream.mock.calls[0]?.[1] as RequestInit).body))
        expect(request).toMatchObject({
            input: 'portrait',
            action: 'generate',
            parameters: { negative_prompt: 'blur', seed: 42, steps: 28 },
        })
    })

    it('keeps ComfyUI local and accepts only the bound browser bridge result', async () => {
        const routes = new Map<string, Function>()
        const app = {
            post: (path: string, handler: Function) => routes.set(`POST ${path}`, handler),
            get: (path: string, handler: Function) => routes.set(`GET ${path}`, handler),
        }
        const service = installImageGenerationJobRoutes(app, {
            checkProxyAuth: async () => true,
            requireSyncClientId: () => true,
            logger: { warn: vi.fn() },
        })
        const result = service.executeImageGeneration({
            jobId: 'workflow:comfy',
            settings: { sdProvider: 'comfyui' },
            prompt: 'portrait',
            negativePrompt: 'blur',
            seed: 42,
            bridgeId: 'comfy-device-1',
        })
        const job = service.jobs.get('workflow:comfy')
        expect(service.publicJob(job)).toMatchObject({
            provider: 'comfyui',
            status: 'waiting_client',
            bridgeId: 'comfy-device-1',
            bridgeRequest: { prompt: 'portrait', negativePrompt: 'blur', seed: 42 },
        })
        expect(service.publicJob(job)).not.toHaveProperty('bridgeRequest.workflow')
        expect(service.publicJob(job)).not.toHaveProperty('bridgeRequest.baseUrl')

        const submittedRoute = routes.get(
            'POST /api/image-generation/jobs/:jobId/comfy/submitted',
        )!
        const completeRoute = routes.get(
            'POST /api/image-generation/jobs/:jobId/comfy/complete',
        )!
        const wrongDevice = responseRecorder()
        await submittedRoute({
            params: { jobId: 'workflow:comfy' },
            body: { bridgeId: 'comfy-device-2', promptId: 'prompt-1', clientId: 'client-1' },
        }, wrongDevice)
        expect(wrongDevice.statusCode).toBe(403)

        await submittedRoute({
            params: { jobId: 'workflow:comfy' },
            body: { bridgeId: 'comfy-device-1', promptId: 'prompt-1', clientId: 'client-1' },
        }, responseRecorder())
        await completeRoute({
            params: { jobId: 'workflow:comfy' },
            body: {
                bridgeId: 'comfy-device-1',
                promptId: 'prompt-1',
                resultBase64: Buffer.from([9, 8, 7]).toString('base64'),
                resultFormat: 'png',
            },
        }, responseRecorder())

        expect([...((await result).image)]).toEqual([9, 8, 7])
        expect(job.status).toBe('completed')
    })

    it('aborts active jobs at the Node process boundary', async () => {
        const routes = new Map<string, Function>()
        const app = {
            post: (path: string, handler: Function) => routes.set(`POST ${path}`, handler),
            get: (path: string, handler: Function) => routes.set(`GET ${path}`, handler),
        }
        vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        })))
        const service = installImageGenerationJobRoutes(app, {
            checkProxyAuth: async () => true,
            logger: { warn: vi.fn() },
        })
        const request = {
            body: {
                jobId: 'workflow-2:image-2',
                provider: 'novelai',
                spec: { apiKey: 'secret', body: { input: 'portrait' } },
            },
        }
        await routes.get('POST /api/image-generation/jobs')!(request, responseRecorder())
        service.abortAll()
        await service.jobs.get(request.body.jobId).runPromise

        expect(service.jobs.get(request.body.jobId).status).toBe('interrupted')
    })

    it('aborts a pending ComfyUI bridge when its workflow is cancelled', async () => {
        const routes = new Map<string, Function>()
        const app = {
            post: (path: string, handler: Function) => routes.set(`POST ${path}`, handler),
            get: (path: string, handler: Function) => routes.set(`GET ${path}`, handler),
        }
        const service = installImageGenerationJobRoutes(app, {
            checkProxyAuth: async () => true,
            logger: { warn: vi.fn() },
        })
        const result = service.executeImageGeneration({
            jobId: 'workflow-cancel:image',
            settings: { sdProvider: 'comfyui', comfyConfig: { timeout: 120 } },
            prompt: 'portrait',
            negativePrompt: '',
            seed: 42,
            bridgeId: 'comfy-device-1',
        })

        await service.abortWorkflow('workflow-cancel')

        await expect(result).rejects.toThrow('Image generation workflow was terminated')
        expect(service.jobs.get('workflow-cancel:image').status).toBe('interrupted')
    })
})
