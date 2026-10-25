export const DEFAULT_TRASH_RETENTION_DAYS = 3;
export const DRIVE_TRASH_DIRECTORY = 'trash';
const DAY_MS = 24 * 60 * 60 * 1000;

/** @param {unknown} value */
export function normalizeTrashRetentionDays(value) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.floor(value))
        : DEFAULT_TRASH_RETENTION_DAYS;
}

/**
 * Zero disables expiry; invalid timestamps never expire.
 * @param {unknown} trashTime
 * @param {unknown} retentionDays
 */
export function isTrashExpired(trashTime, retentionDays, now = Date.now()) {
    const days = normalizeTrashRetentionDays(retentionDays);
    return days > 0 && typeof trashTime === 'number' && Number.isFinite(trashTime)
        && trashTime > 0 && trashTime + days * DAY_MS < now;
}
