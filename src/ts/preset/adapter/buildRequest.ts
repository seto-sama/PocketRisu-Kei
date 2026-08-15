import type { ResolvedModelProfileSnapshot } from '../types'
import {
    getEffectiveMappedValue,
    getEffectivePresetValue,
} from '../runtime/effectiveConfig'
import {
    applyAdditionalParameters,
    parseAdditionalParametersText,
} from '../runtime/additionalParameters'
import { appendQuery, applyAuth } from './auth'
import {
    buildCloudflareAiEndpointUrl,
    CLOUDFLARE_CUSTOM_PATH_ACCOUNT_ID,
} from './cloudflareEndpoint'
import {
    BEDROCK_CUSTOM_PATH_REGION,
    buildBedrockConverseEndpointUrl,
    buildBedrockMantleEndpointUrl,
} from './bedrockEndpoint'
import { ModelPresetAdapterError } from './error'
import type { AdapterPreparedRequest, AdapterRequestContext } from './types'
import { applyCustomRequestValues, resolvePresetAuth } from './customPreset'
import {
    buildVertexGeminiEndpointUrl,
    buildVertexOpenAIEndpointUrl,
    resolveVertexProject,
    VERTEX_CUSTOM_PATH_LOCATION,
    VERTEX_CUSTOM_PATH_PROJECT,
    VERTEX_SERVICE_ACCOUNT_JSON_KEY,
    type VertexEndpointInput,
} from './vertexEndpoint'

export function buildPreparedRequest(ctx: AdapterRequestContext): AdapterPreparedRequest {
    const snapshot = ctx.preset.profileSnapshot
    const baseUrl = resolveEndpointUrl(snapshot, ctx.preset.userValues, ctx.serviceAccountJson)

    const body: Record<string, unknown> = structuredClone({
        ...(snapshot.defaults ?? {}),
        ...(snapshot.bodyTemplate ?? {}),
    })
    const headers: Record<string, string> = { ...(snapshot.headerTemplate ?? {}) }
    const queryAdditions: Array<[string, string]> = []

    const userValues = ctx.preset.userValues
    for (const field of snapshot.schema) {
        if (!field.mapsTo) continue
        const effective = getEffectivePresetValue(ctx.preset, field.key)
        // Treat an empty string as "unset": a combobox/text field cleared back
        // to blank leaves '' in userValues, and sending e.g. reasoning_effort:''
        // is rejected by providers (no enum match). Skip it like undefined.
        if (effective === undefined || effective === '') continue
        switch (field.mapsTo.target) {
            case 'body':
                setNested(body, field.mapsTo.path, effective)
                break
            case 'header':
                headers[field.mapsTo.path] = String(effective)
                break
            case 'query':
                queryAdditions.push([field.mapsTo.path, String(effective)])
                break
            case 'auth':
            case 'custom':
                // 'auth' values flow through applyAuth via credential; 'custom' is adapter-specific.
                break
        }
    }

    if (ctx.preset.customBody) {
        Object.assign(body, structuredClone(ctx.preset.customBody))
    }
    if (ctx.preset.customHeaders) {
        Object.assign(headers, ctx.preset.customHeaders)
    }
    applyCustomRequestValues(ctx.preset, body, headers)
    // Freeform "additional parameters" textarea.
    // Routes `header::` prefix to headers, everything else to body. Sits
    // AFTER customBody so user-typed overrides have the final say, but
    // BEFORE applyAuth so auth headers cannot be hijacked.
    const additionalText = ctx.preset.additionalParamsText
    if (typeof additionalText === 'string' && additionalText.trim().length > 0) {
        applyAdditionalParameters(
            body,
            headers,
            parseAdditionalParametersText(additionalText),
        )
    }

    let url = baseUrl
    for (const [k, v] of queryAdditions) {
        url = appendQuery(url, k, v)
    }

    const prepared: AdapterPreparedRequest = {
        method: 'POST',
        url,
        headers,
        body,
    }
    return applyAuth(prepared, resolvePresetAuth(ctx.preset), ctx.credential)
}

function resolveEndpointUrl(
    snapshot: ResolvedModelProfileSnapshot,
    userValues: Record<string, unknown>,
    serviceAccountJson?: string,
): string {
    // Endpoint override primitive: a schema field with
    // `mapsTo: { target: 'custom', path: 'endpointUrl' }` lets users plug in
    // a base URL on profiles that ship with an empty endpoint.url
    // (e.g. openai-compatible:custom). Migration analyzer writes this value
    // into `userValues.endpointUrl` for custom OpenAI-compatible providers.
    // Vertex kinds assemble their URL from project/location, so an absent or
    // blank `endpointUrl` field there means "no override → assemble", not an
    // error. For other kinds (e.g. openai-compatible:custom whose only URL
    // source IS this field) a present-but-empty override stays a hard error.
    const overrideOptional =
        snapshot.endpoint.kind === 'vertex-openai' || snapshot.endpoint.kind === 'vertex-gemini'
    const override = pickEndpointOverride(snapshot, userValues)
    if (override !== undefined && !(overrideOptional && override.trim().length === 0)) {
        if (override.length === 0) {
            throw new ModelPresetAdapterError(
                'invalid-request',
                'Endpoint URL override is empty',
                { retryable: false },
            )
        }
        return override
    }
    if (snapshot.endpoint.kind === 'static') {
        if (!snapshot.endpoint.url) {
            throw new ModelPresetAdapterError(
                'invalid-request',
                'Endpoint URL is missing in profile snapshot',
                { retryable: false },
            )
        }
        return snapshot.endpoint.url
    }
    if (snapshot.endpoint.kind === 'cloudflare-ai') {
        return buildCloudflareAiEndpointUrl(
            pickCustomString(snapshot, userValues, CLOUDFLARE_CUSTOM_PATH_ACCOUNT_ID),
            snapshot.endpoint.path,
        )
    }
    if (snapshot.endpoint.kind === 'amazon-bedrock') {
        return buildBedrockConverseEndpointUrl(
            pickCustomString(snapshot, userValues, BEDROCK_CUSTOM_PATH_REGION),
            snapshot.modelId,
        )
    }
    if (snapshot.endpoint.kind === 'amazon-bedrock-mantle') {
        return buildBedrockMantleEndpointUrl(
            pickCustomString(snapshot, userValues, BEDROCK_CUSTOM_PATH_REGION),
            snapshot.endpoint.path,
        )
    }
    if (snapshot.endpoint.kind === 'vertex-openai') {
        return buildVertexOpenAIEndpointUrl(
            resolveVertexEndpointInput(snapshot, userValues, serviceAccountJson),
        )
    }
    if (snapshot.endpoint.kind === 'vertex-gemini') {
        return buildVertexGeminiEndpointUrl(
            resolveVertexEndpointInput(snapshot, userValues, serviceAccountJson),
        )
    }
    throw new ModelPresetAdapterError(
        'unsupported',
        `Endpoint kind '${snapshot.endpoint.kind}' is not supported by the shared request builder yet`,
        { retryable: false },
    )
}

// Resolve the { project, location } pair for either Vertex endpoint kind.
// project: explicit custom.project wins; when blank it is recovered from the
// Service Account JSON's `project_id` (resolveVertexProject throws a clear
// invalid-request if neither is available). location: custom.location, or
// 'global' when the schema default is absent / the field was cleared to blank.
//
// SA JSON source: the direct-mode userValues field is preferred, falling back to
// `credentialServiceAccountJson` (threaded from the credential chain by
// prepareAdapterRequest). The fallback is what covers pooled / inline SA keys,
// where the JSON is stored in db.apiKeyPool / preset.inlineCredential and never
// written to userValues.serviceAccountJson. Both sources carry the same
// project_id, so preferring userValues keeps the direct-mode path unchanged.
function resolveVertexEndpointInput(
    snapshot: ResolvedModelProfileSnapshot,
    userValues: Record<string, unknown>,
    credentialServiceAccountJson?: string,
): VertexEndpointInput {
    const explicitProject = pickCustomString(snapshot, userValues, VERTEX_CUSTOM_PATH_PROJECT)
    const rawLocation = pickCustomString(snapshot, userValues, VERTEX_CUSTOM_PATH_LOCATION)
    const location =
        typeof rawLocation === 'string' && rawLocation.trim().length > 0 ? rawLocation : 'global'
    const userValuesSaJson = userValues[VERTEX_SERVICE_ACCOUNT_JSON_KEY]
    const serviceAccountJson =
        typeof userValuesSaJson === 'string' && userValuesSaJson.trim().length > 0
            ? userValuesSaJson
            : credentialServiceAccountJson
    const project = resolveVertexProject(explicitProject, serviceAccountJson)
    return { project, location }
}

function pickEndpointOverride(
    snapshot: ResolvedModelProfileSnapshot,
    userValues: Record<string, unknown>,
): string | undefined {
    return pickCustomString(snapshot, userValues, 'endpointUrl')
}

function pickCustomString(
    snapshot: ResolvedModelProfileSnapshot,
    userValues: Record<string, unknown>,
    path: string,
): string | undefined {
    const value = getEffectiveMappedValue(
        { profileSnapshot: snapshot, userValues },
        'custom',
        path,
    )
    return typeof value === 'string' ? value : undefined
}

function setNested(obj: Record<string, unknown>, path: string, value: unknown): void {
    if (path.length === 0) return
    const parts = path.split('.')
    let cur: Record<string, unknown> = obj
    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i]
        const next = cur[part]
        if (typeof next !== 'object' || next === null || Array.isArray(next)) {
            cur[part] = {}
        }
        cur = cur[part] as Record<string, unknown>
    }
    cur[parts[parts.length - 1]] = value
}
