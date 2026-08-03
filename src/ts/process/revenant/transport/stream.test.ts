import { describe, expect, test } from 'vitest'
import { GenerationJobRegistrationError } from './stream'

describe('GenerationJobRegistrationError', () => {
    test('preserves the server status and detail', () => {
        const error = new GenerationJobRegistrationError(409, 'workflow owner mismatch')
        expect(error).toMatchObject({
            name: 'GenerationJobRegistrationError',
            status: 409,
            message: 'Failed to create generation job: 409 workflow owner mismatch',
        })
    })
})
