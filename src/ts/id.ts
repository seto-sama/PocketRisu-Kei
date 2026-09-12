import { v4 as uuidv4 } from 'uuid'

/** Creates a random stable identifier for persisted and runtime entities. */
export function createEntityId(): string {
    return uuidv4()
}
