import { addExtension, Packr } from 'msgpackr'

const FORMAT_MAGIC = new Uint8Array([0x89, 0x4c, 0x50, 0x53]) // invalid UTF-8 + "LPS"
const FORMAT_VERSION = 1
const HEADER_LENGTH = FORMAT_MAGIC.length + 1
const BINARY_EXTENSION_TYPE = 100
const TYPED_VIEW_CONSTRUCTORS = new Map(
    [
        'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
        'Int32Array', 'Uint32Array', 'Float16Array', 'Float32Array', 'Float64Array',
        'BigInt64Array', 'BigUint64Array',
    ].flatMap(name => typeof globalThis[name] === 'function' ? [[name, globalThis[name]]] : []),
)

class LocalPluginValueReference {
    constructor(value) {
        Object.assign(this, value)
    }
}

addExtension({
    Class: LocalPluginValueReference,
    type: BINARY_EXTENSION_TYPE,
    write(reference) {
        if (reference.kind === 'view') {
            return [
                FORMAT_VERSION,
                'view',
                reference.viewName,
                reference.buffer,
                reference.byteOffset,
                reference.length,
            ]
        }
        return [
            FORMAT_VERSION,
            reference.kind,
            reference.type,
            reference.name,
            reference.lastModified,
            reference.bytes,
        ]
    },
    read(value) {
        if (!Array.isArray(value) || value.length !== 6 || value[0] !== FORMAT_VERSION) {
            throw new TypeError('Invalid local plugin binary value')
        }

        if (value[1] === 'view') {
            const [, , viewName, buffer, byteOffset, length] = value
            if (typeof viewName !== 'string' || !(buffer instanceof ArrayBuffer) ||
                !Number.isInteger(byteOffset) || byteOffset < 0 ||
                !Number.isInteger(length) || length < 0) {
                throw new TypeError('Invalid local plugin buffer view')
            }
            if (viewName === 'DataView') return new DataView(buffer, byteOffset, length)
            const View = TYPED_VIEW_CONSTRUCTORS.get(viewName)
            if (!View) {
                throw new TypeError(`Unsupported local plugin typed view: ${viewName}`)
            }
            return new View(buffer, byteOffset, length)
        }

        const [, kind, type, name, lastModified, bytes] = value
        if ((kind !== 'blob' && kind !== 'file') || typeof type !== 'string' ||
            !(bytes instanceof Uint8Array)) {
            throw new TypeError('Invalid local plugin binary value')
        }
        const blob = new Blob([bytes], { type })
        if (kind === 'blob') return blob

        if (typeof File !== 'function') {
            throw new TypeError('This environment cannot restore File values')
        }
        return new File([blob], name, { type, lastModified })
    },
})

const packr = new Packr({
    structuredClone: true,
    moreTypes: true,
    useBigIntExtension: true,
    useToJSON: false,
    copyBuffers: true,
})

function isSharedArrayBuffer(value) {
    return typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer
}

function copyArrayBuffer(buffer, copies) {
    if (isSharedArrayBuffer(buffer)) {
        throw new TypeError('SharedArrayBuffer values are not supported in local plugin storage')
    }
    if (!(buffer instanceof ArrayBuffer)) {
        throw new TypeError('Unsupported buffer type in local plugin storage')
    }
    if (buffer.resizable) {
        throw new TypeError('Resizable ArrayBuffer values are not supported in local plugin storage')
    }

    const existing = copies.get(buffer)
    if (existing) return existing

    let copy
    try {
        copy = buffer.slice(0)
    } catch {
        throw new TypeError('Detached ArrayBuffer values are not supported in local plugin storage')
    }
    copies.set(buffer, copy)
    return copy
}

function snapshotValueGraph(value) {
    const snapshots = new WeakMap()
    const blobSnapshots = []

    function snapshot(value) {
        if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
            typeof value === 'number' || typeof value === 'bigint' || typeof value === 'undefined') {
            return value
        }
        if (typeof value === 'function') {
            throw new TypeError('Functions cannot be stored in local plugin storage')
        }
        if (typeof value === 'symbol') {
            throw new TypeError('Symbols cannot be stored in local plugin storage')
        }

        const existing = snapshots.get(value)
        if (existing) return existing

        if (typeof Blob === 'function' && value instanceof Blob) {
            const isFile = typeof File === 'function' && value instanceof File
            const copy = new LocalPluginValueReference({
                kind: isFile ? 'file' : 'blob',
                bytes: null,
                type: value.type,
                name: isFile ? value.name : undefined,
                lastModified: isFile ? value.lastModified : undefined,
            })
            snapshots.set(value, copy)
            const byteSnapshot = value.arrayBuffer().then(bytes => {
                copy.bytes = new Uint8Array(bytes)
            })
            blobSnapshots.push(byteSnapshot)
            return copy
        }

        if (value instanceof Date) {
            const copy = new Date(value.getTime())
            snapshots.set(value, copy)
            return copy
        }

        if (value instanceof RegExp) {
            const copy = new RegExp(value.source, value.flags)
            snapshots.set(value, copy)
            return copy
        }

        if (value instanceof ArrayBuffer || isSharedArrayBuffer(value)) {
            return copyArrayBuffer(value, snapshots)
        }

        if (ArrayBuffer.isView(value)) {
            const backingBuffer = copyArrayBuffer(value.buffer, snapshots)
            const viewName = Object.prototype.toString.call(value).slice(8, -1)
            const length = value instanceof DataView ? value.byteLength : value.length
            if ((viewName !== 'DataView' && !TYPED_VIEW_CONSTRUCTORS.has(viewName)) ||
                !Number.isInteger(length)) {
                throw new TypeError('Unsupported typed array view in local plugin storage')
            }
            const copy = new LocalPluginValueReference({
                kind: 'view',
                viewName,
                buffer: backingBuffer,
                byteOffset: value.byteOffset,
                length,
            })
            snapshots.set(value, copy)
            return copy
        }

        if (value instanceof Map) {
            const copy = new Map()
            snapshots.set(value, copy)
            for (const [key, entryValue] of value) copy.set(snapshot(key), snapshot(entryValue))
            rejectSymbolKeys(value)
            return copy
        }

        if (value instanceof Set) {
            const copy = new Set()
            snapshots.set(value, copy)
            for (const entryValue of value) copy.add(snapshot(entryValue))
            rejectSymbolKeys(value)
            return copy
        }

        if (Array.isArray(value)) {
            const copy = new Array(value.length)
            snapshots.set(value, copy)
            rejectSymbolKeys(value)
            for (let index = 0; index < value.length; index++) {
                if (Object.hasOwn(value, index)) copy[index] = snapshot(value[index])
            }
            return copy
        }

        const prototype = Object.getPrototypeOf(value)
        if (prototype !== Object.prototype && prototype !== null) {
            throw new TypeError(`Unsupported object type in local plugin storage: ${value.constructor?.name ?? 'unknown'}`)
        }

        const copy = Object.create(prototype)
        snapshots.set(value, copy)
        copyEnumerableProperties(value, copy, snapshot)
        return copy
    }

    function rejectSymbolKeys(value) {
        if (Object.getOwnPropertySymbols(value).length > 0) {
            throw new TypeError('Symbol keys cannot be stored in local plugin storage')
        }
    }

    function copyEnumerableProperties(source, target, snapshot) {
        rejectSymbolKeys(source)
        for (const key of Object.keys(source)) {
            Object.defineProperty(target, key, {
                value: snapshot(source[key]),
                enumerable: true,
                configurable: true,
                writable: true,
            })
        }
    }

    return { value: snapshot(value), blobSnapshots }
}

export async function encodeLocalPluginStorageValue(value) {
    const snapshot = snapshotValueGraph(value)
    await Promise.all(snapshot.blobSnapshots)

    const payload = packr.pack(snapshot.value)
    const encoded = new Uint8Array(HEADER_LENGTH + payload.length)
    encoded.set(FORMAT_MAGIC)
    encoded[FORMAT_MAGIC.length] = FORMAT_VERSION
    encoded.set(payload, HEADER_LENGTH)
    return encoded
}

/** @param {Uint8Array} bytes */
export function decodeLocalPluginStorageValue(bytes) {
    const hasMagic = bytes.length >= FORMAT_MAGIC.length &&
        FORMAT_MAGIC.every((byte, index) => bytes[index] === byte)

    if (hasMagic) {
        if (bytes.length < HEADER_LENGTH || bytes[FORMAT_MAGIC.length] !== FORMAT_VERSION) {
            throw new TypeError('Unsupported local plugin storage value version')
        }
        return packr.unpack(bytes.subarray(HEADER_LENGTH))
    }

    return JSON.parse(new TextDecoder().decode(bytes))
}
