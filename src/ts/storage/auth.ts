import { forageStorage } from './autoStorage'

/** Lazy-bound access to session auth without importing the global API graph. */
export function createStorageAuth() {
    return forageStorage.createAuth()
}
