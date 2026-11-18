// Reserved Drive root folder that privacy guard hides, together with the trash it may have fed.
export const DRIVE_PRIVATE_DIRECTORY = 'private';

/** @param {string} path */
export function isDrivePrivatePath(path) {
    return path.split('/')[0].toLowerCase() === DRIVE_PRIVATE_DIRECTORY;
}
