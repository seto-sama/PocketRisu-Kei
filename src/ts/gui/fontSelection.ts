export interface ResolvedFontSelection {
    family: string
    weight: number | null
}

export interface LocalFontFamily {
    family: string
    variableWeight: boolean
}

function splitFirstFamily(value: string): { first: string, fallback: string } {
    let quote: '"' | "'" | null = null
    let escaped = false

    for (let index = 0; index < value.length; index++) {
        const character = value[index]
        if (escaped) {
            escaped = false
            continue
        }
        if (character === '\\') {
            escaped = true
            continue
        }
        if (quote) {
            if (character === quote) {
                quote = null
            }
            continue
        }
        if (character === '"' || character === "'") {
            quote = character
            continue
        }
        if (character === ',') {
            return {
                first: value.slice(0, index).trim(),
                fallback: value.slice(index),
            }
        }
    }

    return { first: value.trim(), fallback: '' }
}

function unquote(value: string): string {
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.at(-1) === quote) {
        return value.slice(1, -1)
    }
    return value
}

function quoteCssFamily(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function resolveLocalFontSelection(
    value: string,
    localFontFamilies: readonly LocalFontFamily[],
): ResolvedFontSelection {
    const trimmed = value.trim()
    const { first, fallback } = splitFirstFamily(trimmed)
    const unquotedFirst = unquote(first)
    const families = [...localFontFamilies].sort((a, b) => b.family.length - a.family.length)

    const normalizedFirst = unquotedFirst.toLowerCase()
    const exactFamily = families.find(({ family }) => family.toLowerCase() === normalizedFirst)
    if (exactFamily) {
        return {
            family: `${quoteCssFamily(exactFamily.family)}${fallback}`,
            weight: null,
        }
    }

    for (const { family, variableWeight } of families) {
        if (!variableWeight) {
            continue
        }
        const prefix = `${family.toLowerCase()} `
        if (!normalizedFirst.startsWith(prefix)) {
            continue
        }

        const weightText = unquotedFirst.slice(family.length).trim()
        if (!/^\d{3}$/.test(weightText)) {
            continue
        }

        const weight = Number(weightText)
        if (weight < 100 || weight > 900) {
            continue
        }

        return {
            family: `${quoteCssFamily(family)}${fallback}`,
            weight,
        }
    }

    return { family: value, weight: null }
}
