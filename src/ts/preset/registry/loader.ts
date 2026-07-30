import type { BaseProviderDefinition, ModelProfile, RegistryCache } from '../types'
import developerProvider from './bundled/base-providers/developer.json'
import developerCustomProvider from './bundled/base-providers/developer-custom.json'
import echoProfile from './bundled/profiles/developer/echo.json'
import customProfile from './bundled/profiles/developer/custom.json'
import { MODELS_DEV_REGISTRY_ID } from './modelsDev'

let cachedRegistry: RegistryCache | undefined

function buildSpecialRegistry(): RegistryCache {
    const provider = developerProvider as BaseProviderDefinition
    const customProvider = developerCustomProvider as BaseProviderDefinition
    const echo = echoProfile as ModelProfile
    const custom = customProfile as ModelProfile

    return {
        schemaVersion: 4,
        registries: {
            [MODELS_DEV_REGISTRY_ID]: {
                fetchedAt: 0,
                baseProviders: {
                    [provider.id]: provider,
                    [customProvider.id]: customProvider,
                },
                profiles: {
                    [echo.id]: echo,
                    [custom.id]: custom,
                },
            },
        },
    }
}

/** The built-in Developer catalog entries. Everything else comes from models.dev. */
export function loadSpecialRegistry(): RegistryCache {
    if (!cachedRegistry) {
        cachedRegistry = buildSpecialRegistry()
    }
    return cachedRegistry
}

export function getOfficialRegistryId(): string {
    return MODELS_DEV_REGISTRY_ID
}

// Compatibility aliases for extensions/tests that imported the old names.
export const loadBundledRegistry = loadSpecialRegistry
export const getBundledRegistryId = getOfficialRegistryId
