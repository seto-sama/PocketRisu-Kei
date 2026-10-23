'use strict';

const dns = require('node:dns');
const net = require('node:net');
const { Pool } = require('undici');
const ipaddr = require('ipaddr.js');

const CONFIGURABLE_LOCAL_RANGES = new Set(['private', 'loopback', 'uniqueLocal']);
const POOL_CACHE_TARGET_SIZE = 32;
const POOL_IDLE_TIMEOUT_MS = 30_000;

class OutboundTargetBlockedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'OutboundTargetBlockedError';
        this.code = 'OUTBOUND_TARGET_BLOCKED';
    }
}

function blocked(message) {
    return new OutboundTargetBlockedError(message);
}

function hostnameForAddress(hostname) {
    return hostname.startsWith('[') && hostname.endsWith(']')
        ? hostname.slice(1, -1)
        : hostname;
}

function addressRange(address) {
    if (typeof address !== 'string' || !ipaddr.isValid(address)) {
        throw blocked('Invalid upstream IP address');
    }
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) {
        parsed = parsed.toIPv4Address();
    }
    // EC2's IPv6 metadata endpoint belongs to ULA, unlike IPv4 IMDS's link-local range.
    if (parsed.kind() === 'ipv6' && parsed.toString() === 'fd00:ec2::254') return 'metadata';
    return parsed.range();
}

function parseHttpUrl(value, label = 'Outbound URL') {
    if (typeof value !== 'string' && !(value instanceof URL)) {
        throw blocked(`${label} must be an absolute HTTP(S) URL`);
    }
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw blocked(`${label} must be an absolute HTTP(S) URL`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw blocked(`${label} must use HTTP or HTTPS`);
    }
    if (parsed.username || parsed.password) {
        throw blocked(`${label} must not contain credentials`);
    }
    parsed.hash = '';
    return parsed;
}

function configuredLocalUrls(getAllowedLocalUrls) {
    const values = getAllowedLocalUrls();
    if (!Array.isArray(values)) return [];
    return values.flatMap(value => {
        try {
            return [parseHttpUrl(value, 'Configured local URL')];
        } catch {
            return [];
        }
    });
}

function normalizedPathname(pathname) {
    try {
        let decoded = pathname;
        for (let pass = 0; pass < 8; pass++) {
            const next = decodeURIComponent(decoded);
            if (next === decoded) break;
            decoded = next;
            if (pass === 7) throw blocked('Outbound URL path has excessive encoding');
        }

        // Proxies and upstream frameworks disagree about encoded separators;
        // treating either slash form as a segment boundary keeps traversal
        // checks conservative for the local-endpoint exception.
        const segments = [];
        for (const segment of decoded.replace(/\\/g, '/').split('/')) {
            if (segment === '' || segment === '.') continue;
            if (segment === '..') segments.pop();
            else segments.push(segment);
        }
        const result = `/${segments.join('/')}`;
        return decoded.endsWith('/') && result !== '/' ? `${result}/` : result;
    } catch {
        throw blocked('Outbound URL has an invalid path');
    }
}

function isWithinBasePath(targetPath, basePath) {
    const target = normalizedPathname(targetPath);
    const base = normalizedPathname(basePath).replace(/\/+$/, '');
    return target === base || target.startsWith(`${base}/`);
}

function isConfiguredLocalUrl(target, allowedUrls) {
    return allowedUrls.some(allowed =>
        target.origin === allowed.origin
        && isWithinBasePath(target.pathname, allowed.pathname));
}

function normalizeLookupRecords(records) {
    const list = Array.isArray(records) ? records : [records];
    const normalized = list.flatMap(record => {
        if (!record || typeof record.address !== 'string') return [];
        const family = Number(record.family) || net.isIP(record.address);
        if (family !== 4 && family !== 6) return [];
        return [{ address: record.address, family }];
    });
    if (normalized.length === 0) throw blocked('Outbound destination did not resolve to an IP address');
    return normalized;
}

function resolveAll(hostname, lookup) {
    return new Promise((resolve, reject) => {
        lookup(hostname, { all: true, verbatim: true }, (error, records) => {
            if (error) return reject(error);
            try {
                resolve(normalizeLookupRecords(records));
            } catch (error) {
                reject(error);
            }
        });
    });
}

function createPinnedLookup(expectedHostname, records) {
    const expected = hostnameForAddress(expectedHostname).toLowerCase().replace(/\.$/, '');
    return (hostname, options, callback) => {
        if (typeof options === 'function') {
            callback = options;
            options = {};
        }
        const actual = hostnameForAddress(String(hostname)).toLowerCase().replace(/\.$/, '');
        if (actual !== expected) {
            const error = blocked('Outbound dispatcher cannot be reused for another hostname');
            callback(error);
            return;
        }
        const candidates = options?.family
            ? records.filter(record => record.family === options.family)
            : records;
        if (candidates.length === 0) {
            const error = blocked('Pinned outbound address does not match the requested family');
            callback(error);
            return;
        }
        if (options?.all) {
            callback(null, candidates.map(record => ({ ...record })));
        } else {
            callback(null, candidates[0].address, candidates[0].family);
        }
    };
}

function createOutboundPolicy({ getAllowedLocalUrls = () => [], lookup = dns.lookup } = {}) {
    const pools = new Map();
    let closed = false;

    function closePool(key, entry) {
        pools.delete(key);
        clearTimeout(entry.timer);
        return entry.dispatcher.close();
    }

    function trimIdlePools() {
        for (const [key, entry] of pools) {
            if (pools.size <= POOL_CACHE_TARGET_SIZE) break;
            // A lease may not have dispatched its request yet, so closing an
            // in-use pool could reject work before it reaches the network.
            if (entry.active === 0) void closePool(key, entry).catch(() => {});
        }
    }

    function authorizeAddresses(target, records) {
        let needsLocalPermission = false;
        for (const { address } of records) {
            const range = addressRange(address);
            if (range === 'unicast') continue;
            if (!CONFIGURABLE_LOCAL_RANGES.has(range)) {
                throw blocked('Outbound destination resolves to a restricted IP address');
            }
            needsLocalPermission = true;
        }
        if (needsLocalPermission && !isConfiguredLocalUrl(target, configuredLocalUrls(getAllowedLocalUrls))) {
            throw blocked('Outbound destination resolves to a restricted IP address');
        }
    }

    async function prepare(url) {
        const parsed = parseHttpUrl(url);
        const hostname = hostnameForAddress(parsed.hostname);
        const literalFamily = net.isIP(hostname);
        const records = literalFamily
            ? [{ address: hostname, family: literalFamily }]
            : await resolveAll(hostname, lookup);

        // Never reuse a cached pool until the complete current DNS answer and
        // current local-endpoint permissions have passed authorization.
        authorizeAddresses(parsed, records);
        if (closed) throw new Error('Outbound policy is closed');
        const key = JSON.stringify([parsed.origin, records.map(({ address, family }) => [address, family]).sort()]);
        let entry = pools.get(key);
        if (!entry) {
            entry = {
                active: 0,
                dispatcher: new Pool(parsed.origin, {
                    connect: { lookup: createPinnedLookup(hostname, records) },
                    keepAliveTimeout: POOL_IDLE_TIMEOUT_MS,
                    keepAliveMaxTimeout: POOL_IDLE_TIMEOUT_MS,
                }),
            };
        }
        entry.active++;
        clearTimeout(entry.timer);
        pools.delete(key);
        pools.set(key, entry);
        if (pools.size > POOL_CACHE_TARGET_SIZE) trimIdlePools();

        let released = false;
        return {
            url: parsed.toString(),
            dispatcher: entry.dispatcher,
            release() {
                if (released) return;
                released = true;
                if (--entry.active > 0 || closed) return;
                if (pools.size > POOL_CACHE_TARGET_SIZE) trimIdlePools();
                if (!pools.has(key)) return;
                entry.timer = setTimeout(() => { void closePool(key, entry).catch(() => {}); }, POOL_IDLE_TIMEOUT_MS);
                entry.timer.unref();
            },
        };
    }

    async function close() {
        closed = true;
        await Promise.all([...pools].map(([key, entry]) => closePool(key, entry)));
    }

    return { prepare, close };
}

module.exports = { createOutboundPolicy };
