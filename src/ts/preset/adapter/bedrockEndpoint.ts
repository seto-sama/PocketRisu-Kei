import { ModelPresetAdapterError } from './error'

export const BEDROCK_REGION_KEY = 'bedrockRegion'
export const BEDROCK_CUSTOM_PATH_REGION = 'bedrockRegion'
export const BEDROCK_CREDENTIAL_KEY = 'bedrockCredential'

export function buildBedrockConverseEndpointUrl(
    regionInput: string | undefined,
    modelIdInput: string,
    stream = false,
): string {
    const region = sanitize(regionInput, 'region')
    const modelId = sanitize(modelIdInput, 'model ID')
    const domain = region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com'
    const operation = stream ? 'converse-stream' : 'converse'
    return `https://bedrock-runtime.${region}.${domain}/model/${encodeURIComponent(modelId)}/${operation}`
}

export function buildBedrockMantleEndpointUrl(
    regionInput: string | undefined,
    pathInput = 'v1/responses',
): string {
    const region = sanitize(regionInput, 'region')
    const path = pathInput.replace(/^\/+|\/+$/gu, '')
    if (!path || !/^[a-z0-9/_-]+$/iu.test(path) || path.includes('..')) {
        throw invalid(`Amazon Bedrock Mantle path '${pathInput}' is invalid`)
    }
    return `https://bedrock-mantle.${region}.api.aws/${path}`
}

function sanitize(value: string | undefined, label: string): string {
    const trimmed = value?.trim()
    if (!trimmed) throw invalid(`Amazon Bedrock ${label} is required`)
    if (label === 'region' && !/^[a-z0-9-]+$/u.test(trimmed)) {
        throw invalid(`Amazon Bedrock region '${trimmed}' contains invalid characters`)
    }
    return trimmed
}

function invalid(message: string): ModelPresetAdapterError {
    return new ModelPresetAdapterError('invalid-request', message, {
        retryable: false,
        fallbackEligible: false,
    })
}
