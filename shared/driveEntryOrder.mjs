/** @param {{ type: string, name: string }} a @param {{ type: string, name: string }} b */
export function compareDriveEntries(a, b) {
    return Number(b.type === 'directory') - Number(a.type === 'directory')
        || a.name.localeCompare(b.name, undefined, { numeric: true });
}
