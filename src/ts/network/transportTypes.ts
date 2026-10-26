import type { AdapterResponseDecoder } from '../preset/adapter/types'

/**
 * Application-level execution policy for an LLM provider call.
 *
 * Workflow jobs and standalone calls are recoverable and therefore execute on
 * the server. Ephemeral calls are intentionally not journaled; they still use
 * the server proxy unless browser-direct access is explicitly requested.
 */
export type LLMExecutionPolicy =
    | {
        kind: 'workflow'
        durability: 'required'
        providerRoute: 'server'
    }

    | {
        kind: 'single'
        durability: 'required'
        providerRoute: 'server'
    }
    | {
        kind: 'ephemeral'
        durability: 'off'
        providerRoute: 'server' | 'direct'
    }

export const WORKFLOW_LLM_EXECUTION = Object.freeze({
    kind: 'workflow',
    durability: 'required',
    providerRoute: 'server',
} as const satisfies LLMExecutionPolicy)

export const SINGLE_LLM_EXECUTION = Object.freeze({
    kind: 'single',
    durability: 'required',
    providerRoute: 'server',
} as const satisfies LLMExecutionPolicy)

export const EPHEMERAL_SERVER_LLM_EXECUTION = Object.freeze({
    kind: 'ephemeral',
    durability: 'off',
    providerRoute: 'server',
} as const satisfies LLMExecutionPolicy)

export interface ServerProviderAuth {
    kind: 'google-service-account'
    serviceAccountJson: string
    scope?: string
}

/** Fetch init understood by the LLM transport in addition to RequestInit. */
export interface LLMRequestInit extends RequestInit {
    serverProviderAuth?: ServerProviderAuth
    /** Marks a chat response that the server decodes for the adapter. */
    responseDecoder?: AdapterResponseDecoder
}
