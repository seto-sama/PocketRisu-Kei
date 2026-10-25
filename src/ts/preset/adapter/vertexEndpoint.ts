import { ModelPresetAdapterError } from './error'

export const VERTEX_CUSTOM_PATH_LOCATION = 'location'

export interface VertexEndpointInput {
    project: string
    location: string
}

/** Builds the Vertex AI OpenAI-compatible Chat Completions URL. */
export function buildVertexOpenAIEndpointUrl(input: VertexEndpointInput): string {
    return `${vertexBase(input)}/endpoints/openapi/chat/completions`
}

/** The Gemini adapter appends the model and generateContent method. */
export function buildVertexGeminiEndpointUrl(input: VertexEndpointInput): string {
    return `${vertexBase(input)}/publishers/google/models`
}

function vertexBase(input: VertexEndpointInput): string {
    const project = sanitize(input.project, 'project')
    const location = sanitize(input.location, 'location')
    const host =
        location === 'global'
            ? 'aiplatform.googleapis.com'
            : `${location}-aiplatform.googleapis.com`
    return `https://${host}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}`
}

/** Extracts the project from the account selected for authentication. */
export function resolveVertexProject(serviceAccountJson: unknown): string {
    let parsed: unknown
    if (typeof serviceAccountJson === 'string') {
        try {
            parsed = JSON.parse(serviceAccountJson)
        } catch {}
    }
    const projectId = parsed !== null && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>).project_id
        : undefined
    if (typeof projectId === 'string' && projectId.trim().length > 0) {
        return projectId.trim()
    }
    throw invalid(
        'Could not determine the Vertex project — check the Service Account JSON (it must contain a "project_id")',
    )
}

const ALLOWED = /^[a-z0-9][a-z0-9-]*$/iu

function sanitize(value: string, field: string): string {
    if (typeof value !== 'string') {
        throw invalid(`Vertex ${field} must be a string`)
    }
    const trimmed = value.trim()
    if (trimmed.length === 0) {
        throw invalid(`Vertex ${field} is required`)
    }
    if (!ALLOWED.test(trimmed)) {
        throw invalid(
            `Vertex ${field} '${trimmed}' contains invalid characters (allowed: alphanumerics and '-')`,
        )
    }
    return trimmed
}

function invalid(message: string): ModelPresetAdapterError {
    return new ModelPresetAdapterError('invalid-request', message, {
        retryable: false,
        fallbackEligible: false,
    })
}
