export const DEFAULT_TRASH_RETENTION_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export function normalizeTrashRetentionDays(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.floor(value))
        : DEFAULT_TRASH_RETENTION_DAYS;
}

/** Startup cleanup uses the same normalized value as the editor; zero disables expiry. */
export function isTrashExpired(trashTime: unknown, retentionDays: unknown, now = Date.now()) {
    const days = normalizeTrashRetentionDays(retentionDays);
    return days > 0 && typeof trashTime === 'number' && Number.isFinite(trashTime)
        && trashTime > 0 && trashTime + days * DAY_MS < now;
}
