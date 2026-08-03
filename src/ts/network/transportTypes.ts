/**
 * Routing policy for provider-facing LLM requests.
 *
 * `auto` is the application default: create a recoverable Revenant job first,
 * then fall back to the synchronous server proxy only when job registration is
 * known to have failed before a job was created.
 */
export type LLMTransportStrategy = 'auto' | 'durable' | 'proxy' | 'direct'
