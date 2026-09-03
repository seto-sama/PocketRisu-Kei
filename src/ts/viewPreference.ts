export const viewPreferenceKeys = {
    mainRealm: 'pocketrisu:main-realm-view-mode',
    characterCatalog: 'pocketrisu:character-catalog-view-mode',
} as const;

export function readViewPreference<T extends string>(
    key: string,
    allowedValues: readonly T[],
    fallback: T,
): T {
    if (typeof localStorage === 'undefined') return fallback;

    try {
        const stored = localStorage.getItem(key) as T | null;
        return stored && allowedValues.includes(stored) ? stored : fallback;
    } catch {
        return fallback;
    }
}

export function writeViewPreference(key: string, value: string) {
    if (typeof localStorage === 'undefined') return;

    try {
        localStorage.setItem(key, value);
    } catch {
        // Storage can be unavailable in private or restricted browser contexts.
    }
}
