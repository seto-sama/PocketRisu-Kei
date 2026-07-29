// Catalog display-level filter.
//
// Hides deprecated profiles from the profile browser and the
// "new/updated" notice. This is display-only — profiles are still downloaded
// and stored (the bandwidth/storage cost is negligible at catalog scale; see
// model-preset-settings worklog). The setting buys catalog tidiness, not perf.

import type { RegistryProfileStatus } from '../types'

export type ProfileVisibilityLevel = 'all' | 'hideDeprecated'

// A profile with no explicit status is treated as 'current' (visible).
export function isProfileVisible(
    status: RegistryProfileStatus | undefined,
    level: ProfileVisibilityLevel | undefined,
): boolean {
    const s = status ?? 'current'
    switch (level) {
        case 'hideDeprecated':
            return s !== 'deprecated'
        default:
            return true
    }
}
