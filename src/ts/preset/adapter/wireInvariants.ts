import type { ModelPreset } from '../types'
import { getPresetModelIdValue } from '../runtime/effectiveConfig'
import { ModelPresetAdapterError } from './error'

/**
 * Resolves the wire model id for an adapter directly from the preset's user
 * values / schema default / snapshot, bypassing `customBody`.
 *
 * Per plan §4-5 the model selection is a wire invariant: `customBody.model`
 * must not be able to redirect requests to a different model (or, for Google,
 * a different endpoint URL via the URL path). Adapters use this helper so the
 * value cannot be hijacked by a customBody key collision.
 */
export function resolveWireModelId(
    preset: ModelPreset,
    options: { vendorName?: string } = {},
): string {
    const vendorName = options.vendorName ?? 'Adapter'
    const modelId = getPresetModelIdValue(preset)
    if (typeof modelId === 'string' && modelId.length > 0) return modelId
    throw new ModelPresetAdapterError(
        'invalid-request',
        preset.profileSnapshot.schema.some(
            (field) =>
                field.semantic === 'modelId'
                || (field.semantic === undefined && field.key === 'modelId'),
        )
            ? `${vendorName} adapter requires a non-empty string modelId user value`
            : `${vendorName} adapter requires a modelId`,
        { retryable: false },
    )
}
