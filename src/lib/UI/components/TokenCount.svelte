<script lang="ts">
    import { language } from 'src/lang';
    import { tokenizeAccurate } from 'src/ts/tokenizer';
    import { createDebouncedDraftWriter } from 'src/ts/storage/draftPersistence';
    import { INPUT_COMMIT_DEBOUNCE_MS } from 'src/ts/inputCommit';

    interface Props {
        value?: string | null;
        className?: string;
    }

    let { value = '', className = '' }: Props = $props();
    let tokens = $state(0);
    let sequence = 0;

    const tokenizer = createDebouncedDraftWriter(async (text: string) => {
        const currentSequence = ++sequence;
        const result = await tokenizeAccurate(text);
        if (currentSequence === sequence) tokens = result;
    }, INPUT_COMMIT_DEBOUNCE_MS);

    // tokenizeAccurate expands CBS before encoding. Debounce editor updates and
    // discard stale async results when the value changes while tokenizing.
    $effect(() => {
        const text = value ?? '';
        sequence += 1;
        tokenizer.schedule(text);
        return tokenizer.cancel;
    });
</script>

<span class="block text-sm text-subtext {className}">{tokens} {language.tokens}</span>
