import type { ModelPreset } from '../types'
import type { RevenantProviderJobSpec } from '../../process/revenant/types'
import { MODELS_DEV_REGISTRY_ID } from '../registry/modelsDev'

export function modelsDevUsageIdentity(
    preset: ModelPreset,
): Pick<
    RevenantProviderJobSpec,
    'usageProviderId' | 'usageModelId' | 'usageServiceTier'
> | undefined {
    const source = preset.sourceProfile
    if (source?.registryId !== MODELS_DEV_REGISTRY_ID) return undefined

    const separator = source.profileId.indexOf(':')
    if (separator <= 0 || separator >= source.profileId.length - 1) return undefined
    return {
        usageProviderId: source.profileId.slice(0, separator),
        usageModelId: source.profileId.slice(separator + 1),
        usageServiceTier: preset.claudeBatching ? 'batch' : undefined,
    }
}
