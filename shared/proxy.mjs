export const PROXY_PATH = '/charon';
export const REALM_PROXY_PATH = `${PROXY_PATH}/realm`;
export const REALM_ORIGIN = 'https://sv.risuai.xyz';

/** @param {string} path */
export function getRealmProxyUrl(path) {
    // Resolve upstream dot segments before adding the local route prefix.
    const target = new URL(REALM_ORIGIN + path);
    return `${REALM_PROXY_PATH}${target.pathname}${target.search}${target.hash}`;
}
