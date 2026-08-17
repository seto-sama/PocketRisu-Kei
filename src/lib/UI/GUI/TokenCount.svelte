<script lang="ts">
    import { language } from 'src/lang';
    import { tokenizeAccurate } from 'src/ts/tokenizer';

    const TOKEN_COUNT_DEBOUNCE_MS = 400;

    interface Props {
        value?: string | null;
        className?: string;
    }

    let { value = '', className = '' }: Props = $props();
    let tokens = $state(0);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let sequence = 0;

    // tokenizeAccurate expands CBS before encoding. Debounce editor updates and
    // discard stale async results when the value changes while tokenizing.
    $effect(() => {
        const text = value ?? '';
        const currentSequence = ++sequence;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            tokenizeAccurate(text).then(result => {
                if (currentSequence === sequence) tokens = result;
            });
        }, TOKEN_COUNT_DEBOUNCE_MS);

        return () => {
            if (timer) clearTimeout(timer);
        };
    });
</script>

<span class="block text-sm text-textcolor2 {className}">{tokens} {language.tokens}</span>
