import { beforeEach, describe, expect, test, vi } from 'vitest'

const { fetchNativeMock } = vi.hoisted(() => ({
    fetchNativeMock: vi.fn(),
}))

vi.mock('../globalApi.svelte', () => ({
    fetchNative: fetchNativeMock,
}))

import { createLLMTransportFetch } from './llmTransport'
import {
    EPHEMERAL_DIRECT_LLM_EXECUTION,
    WORKFLOW_LLM_EXECUTION,
} from './transportTypes'
import type { RevenantGenerationRequest } from '../process/revenant'

beforeEach(() => {
    fetchNativeMock.mockReset()
    fetchNativeMock.mockResolvedValue(new Response('{}', { status: 200 }))
})

describe('createLLMTransportFetch', () => {
    test('routes workflow provider requests through required durable policy', async () => {
        const request: RevenantGenerationRequest = {
            job: {
                chatId: 'generation-1',
                jobType: 'model',
                isContinuation: false,
            },
        }
        const fetchImpl = createLLMTransportFetch({
            interceptor: 'model_preset',
            chatId: 'generation-1',
            getGenerationRequest: () => request,
            getExecutionPolicy: () => WORKFLOW_LLM_EXECUTION,
        })

        await fetchImpl('https://api.example.com/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: 'Bearer secret' },
            body: '{"messages":[]}',
        })

        expect(fetchNativeMock).toHaveBeenCalledWith(
            'https://api.example.com/v1/chat/completions',
            expect.objectContaining({
                method: 'POST',
                body: '{"messages":[]}',
                chatId: 'generation-1',
                interceptor: 'model_preset',
                generationRequest: request,
                llmExecutionPolicy: WORKFLOW_LLM_EXECUTION,
                networkRoute: 'auto',
            }),
        )
    })

    test('only selects browser-direct transport through explicit ephemeral policy', async () => {
        const fetchImpl = createLLMTransportFetch({
            interceptor: 'model_preset',
            getGenerationRequest: () => undefined,
            getExecutionPolicy: () => EPHEMERAL_DIRECT_LLM_EXECUTION,
        })

        await fetchImpl('https://api.example.com/health', {
            method: 'GET',
        })

        expect(fetchNativeMock).toHaveBeenCalledWith(
            'https://api.example.com/health',
            expect.objectContaining({
                llmExecutionPolicy: EPHEMERAL_DIRECT_LLM_EXECUTION,
            }),
        )
    })

    test('applies the centralized local-network route and timeout', async () => {
        const fetchImpl = createLLMTransportFetch({
            interceptor: 'model_preset',
            getGenerationRequest: () => ({
                job: {
                    chatId: 'aux-1',
                    jobType: 'otherAx',
                    isContinuation: false,
                },
            }),
            localNetworkTimeoutMs: 123_000,
        })

        await fetchImpl('http://192.168.0.10:11434/v1/chat/completions', {
            method: 'POST',
            body: '{}',
        })

        expect(fetchNativeMock).toHaveBeenCalledWith(
            'http://192.168.0.10:11434/v1/chat/completions',
            expect.objectContaining({
                networkRoute: 'local_network',
                requestTimeoutMs: 123_000,
            }),
        )
    })

    test('resolves generation context for every adapter dispatch', async () => {
        let chatId = 'first'
        const fetchImpl = createLLMTransportFetch({
            interceptor: 'model_preset',
            getGenerationRequest: () => ({
                job: {
                    chatId,
                    jobType: 'model',
                    isContinuation: false,
                },
            }),
        })

        await fetchImpl('https://api.example.com/v1/chat/completions', { method: 'POST', body: '{}' })
        chatId = 'second'
        await fetchImpl('https://api.example.com/v1/chat/completions', { method: 'POST', body: '{}' })

        expect(fetchNativeMock.mock.calls[0][1].generationRequest.job.chatId).toBe('first')
        expect(fetchNativeMock.mock.calls[1][1].generationRequest.job.chatId).toBe('second')
    })
})
