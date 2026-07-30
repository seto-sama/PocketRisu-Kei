import { describe, expect, test } from 'vitest'
import { ModelPresetAdapterError } from './error'
import {
    buildBedrockConverseEndpointUrl,
    buildBedrockMantleEndpointUrl,
} from './bedrockEndpoint'

describe('buildBedrockConverseEndpointUrl', () => {
    test('builds regional Converse and ConverseStream endpoints', () => {
        expect(buildBedrockConverseEndpointUrl('ap-northeast-2', 'global.anthropic.claude:0'))
            .toBe(
                'https://bedrock-runtime.ap-northeast-2.amazonaws.com/model/global.anthropic.claude%3A0/converse',
            )
        expect(buildBedrockConverseEndpointUrl('us-east-1', 'amazon.nova-lite-v1:0', true))
            .toBe(
                'https://bedrock-runtime.us-east-1.amazonaws.com/model/amazon.nova-lite-v1%3A0/converse-stream',
            )
    })

    test('uses the AWS China domain for cn regions', () => {
        expect(buildBedrockConverseEndpointUrl('cn-north-1', 'model'))
            .toContain('bedrock-runtime.cn-north-1.amazonaws.com.cn')
    })

    test('rejects missing and unsafe regions', () => {
        for (const region of ['', 'us-east-1.example.com']) {
            expect(() => buildBedrockConverseEndpointUrl(region, 'model'))
                .toThrowError(ModelPresetAdapterError)
        }
    })
})

describe('buildBedrockMantleEndpointUrl', () => {
    test('builds a regional Mantle route while preserving its API prefix', () => {
        expect(buildBedrockMantleEndpointUrl('us-west-2', 'openai/v1/responses'))
            .toBe('https://bedrock-mantle.us-west-2.api.aws/openai/v1/responses')
    })

    test('rejects unsafe paths', () => {
        expect(() => buildBedrockMantleEndpointUrl('us-east-1', '../responses'))
            .toThrowError(ModelPresetAdapterError)
    })
})
