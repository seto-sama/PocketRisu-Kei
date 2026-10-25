export interface PluginStorageDisplay {
    str: string
    size: number
    type: string
    jsonEditable: boolean
    binarySize: boolean
    mimeType?: string
}

function typeName(value: object): string {
    if (Array.isArray(value)) return 'array'
    if (typeof File !== 'undefined' && value instanceof File) return 'File'
    if (typeof Blob !== 'undefined' && value instanceof Blob) return 'Blob'
    const name = Object.prototype.toString.call(value).slice(8, -1)
    return name === 'Object' ? 'object' : name
}

export function describePluginStorageValue(value: unknown): PluginStorageDisplay {
    const seen = new WeakMap<object, string>()
    const binaryRanges = new Map<ArrayBufferLike, [number, number][]>()
    const mimeTypes = new Set<string>()
    let binaryBytes = 0
    let hasBinary = false
    let jsonEditable = true

    function summarize(item: unknown, path: string, depth: number): unknown {
        if (item === null || typeof item !== 'object') {
            jsonEditable &&= item === null || typeof item === 'string' || typeof item === 'boolean' ||
                (typeof item === 'number' && Number.isFinite(item) && !Object.is(item, -0))
            if (item === undefined) return '[undefined]'
            if (typeof item === 'bigint') return `${item}n`
            if (typeof item === 'symbol') return String(item)
            if (typeof item === 'function') return `[Function${item.name ? `: ${item.name}` : ''}]`
            if (typeof item === 'number' && Object.is(item, -0)) return '[-0]'
            if (typeof item === 'number' && !Number.isFinite(item)) return `[${String(item)}]`
            return item
        }
        if (depth > 24) {
            jsonEditable = false
            return '[Max depth]'
        }

        const priorPath = seen.get(item)
        if (priorPath !== undefined) {
            jsonEditable = false
            return `[Reference: ${priorPath}]`
        }
        seen.set(item, path)

        if (jsonEditable) {
            const array = Array.isArray(item)
            const keys = Reflect.ownKeys(item)
            jsonEditable = array ? keys.length === item.length + 1 : Object.getPrototypeOf(item) === Object.prototype
            for (const key of keys) {
                if (array && key === 'length') continue
                const descriptor = Object.getOwnPropertyDescriptor(item, key)!
                jsonEditable &&= typeof key === 'string' && descriptor.enumerable === true && Object.hasOwn(descriptor, 'value')
            }
        }

        const name = typeName(item)
        if (typeof Blob !== 'undefined' && item instanceof Blob) {
            hasBinary = true
            binaryBytes += item.size
            if (item.type) mimeTypes.add(item.type)
            return `${name} (${item.size} B${item.type ? `, ${item.type}` : ''})`
        }
        if (item instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && item instanceof SharedArrayBuffer)) {
            hasBinary = true
            addBinaryRange(item, 0, item.byteLength)
            return `${name} (${item.byteLength} B)`
        }
        if (ArrayBuffer.isView(item)) {
            hasBinary = true
            addBinaryRange(item.buffer, item.byteOffset, item.byteLength)
            return `${name} (${item.byteLength} B)`
        }
        if (item instanceof Date) return `Date (${Number.isNaN(item.getTime()) ? 'Invalid Date' : item.toISOString()})`
        if (item instanceof RegExp) return `RegExp (${String(item)})`
        if (['Number', 'Boolean', 'String', 'BigInt'].includes(name)) {
            return `${name} (${String((item as { valueOf(): unknown }).valueOf())})`
        }
        if (item instanceof Map) {
            return { Map: [...item].map(([key, entry], index) => [
                summarize(key, `${path}.Map[${index}][0]`, depth + 1),
                summarize(entry, `${path}.Map[${index}][1]`, depth + 1),
            ]) }
        }
        if (item instanceof Set) {
            return { Set: [...item].map((entry, index) => summarize(entry, `${path}.Set[${index}]`, depth + 1)) }
        }
        if (Array.isArray(item)) {
            return Array.from({ length: item.length }, (_, index) => {
                if (Object.hasOwn(item, index)) return summarize(item[index], `${path}[${index}]`, depth + 1)
                jsonEditable = false
                return '[Empty]'
            })
        }

        const result: Record<string, unknown> = Object.create(null)
        for (const [key, child] of Object.entries(item)) {
            result[key] = summarize(child, `${path}.${key}`, depth + 1)
        }
        return result
    }

    function addBinaryRange(buffer: ArrayBufferLike, offset: number, length: number) {
        const ranges = binaryRanges.get(buffer) ?? []
        ranges.push([offset, offset + length])
        binaryRanges.set(buffer, ranges)
    }

    const summary = summarize(value, '$', 0)
    let str: string
    if (typeof value === 'string') str = value
    else if (value === null) str = 'null'
    else if (value === undefined) str = ''
    else if (typeof summary === 'string') str = summary
    else str = JSON.stringify(summary) ?? String(summary)

    for (const ranges of binaryRanges.values()) {
        ranges.sort((a, b) => a[0] - b[0])
        let end = 0
        for (const [start, nextEnd] of ranges) {
            binaryBytes += Math.max(0, nextEnd - Math.max(start, end))
            end = Math.max(end, nextEnd)
        }
    }

    return {
        str,
        size: hasBinary ? binaryBytes : str.length * 2,
        type: value !== null && typeof value === 'object' ? typeName(value)
                : value === null ? 'null' : value === undefined ? 'empty' : typeof value,
        jsonEditable,
        binarySize: hasBinary,
        ...(mimeTypes.size ? { mimeType: [...mimeTypes].join(', ') } : {}),
    }
}
