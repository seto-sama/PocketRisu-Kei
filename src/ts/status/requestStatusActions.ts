// Ephemeral UI actions keyed by request id. Kept outside RequestStatusEntry so
// the status channel remains serializable and surface-agnostic.
const actions = new Map<string, () => void>()

export function setRequestStatusAction(id: string, action?: () => void): void {
    if (action) actions.set(id, action)
    else actions.delete(id)
}

export function clearRequestStatusAction(id: string): void {
    actions.delete(id)
}

export function hasRequestStatusAction(id: string): boolean {
    return actions.has(id)
}

export function activateRequestStatus(id: string): boolean {
    const action = actions.get(id)
    if (!action) return false
    action()
    return true
}
