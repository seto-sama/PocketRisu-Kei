export type AdditionalParameter = readonly [key: string, value: string]

export function setObjectValue<T>(obj: T, key: string, value: unknown): T {
    const splitKey = key.split('.')
    if (splitKey.length > 1) {
        const firstKey = splitKey.shift()
        if (!firstKey) return obj
        const record = obj as Record<string, unknown>
        if (!record[firstKey] || typeof record[firstKey] !== 'object') {
            record[firstKey] = {}
        }
        record[firstKey] = setObjectValue(
            record[firstKey],
            splitKey.join('.'),
            value,
        )
        return obj
    }

    ;(obj as Record<string, unknown>)[key] = value
    return obj
}

/**
 * Parse the model-preset textarea syntax without importing database state.
 * Empty and comment lines are ignored; the value remains byte-for-byte after
 * the first '=' so JSON and URLs containing '=' round-trip correctly.
 */
export function parseAdditionalParametersText(text: string): AdditionalParameter[] {
    const entries: AdditionalParameter[] = []
    for (const raw of text.split('\n')) {
        const line = raw.trim()
        if (line.length === 0 || line.startsWith('#')) continue
        const separator = line.indexOf('=')
        if (separator <= 0) continue
        const key = line.slice(0, separator).trim()
        if (key.length === 0) continue
        entries.push([key, line.slice(separator + 1)])
    }
    return entries
}

export function applyAdditionalParameters<T extends Record<string, unknown>>(
    body: T,
    headers: Record<string, string>,
    additionalParams: readonly AdditionalParameter[],
): T {
    for (const [key, value] of additionalParams) {
        if (!key || !value) continue

        if (value === '{{none}}') {
            if (key.startsWith('header::')) {
                delete headers[key.slice('header::'.length)]
            } else {
                delete body[key]
            }
            continue
        }

        if (key.startsWith('header::')) {
            headers[key.slice('header::'.length)] = value
            continue
        }

        if (value.startsWith('json::')) {
            try {
                body = setObjectValue(body, key, JSON.parse(value.slice('json::'.length)))
            } catch {}
            continue
        }

        if (
            (value.startsWith('"') && value.endsWith('"'))
            || (value.startsWith("'") && value.endsWith("'"))
        ) {
            body = setObjectValue(body, key, value.slice(1, -1))
            continue
        }

        if (value === 'true' || value === 'false') {
            body = setObjectValue(body, key, value === 'true')
            continue
        }

        if (value === 'null') {
            body = setObjectValue(body, key, null)
            continue
        }

        const numberValue = Number(value)
        body = setObjectValue(
            body,
            key,
            Number.isNaN(numberValue) ? value : numberValue,
        )
    }
    return body
}
