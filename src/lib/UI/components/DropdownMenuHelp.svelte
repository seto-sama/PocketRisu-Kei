<script lang="ts">
    import { CircleQuestionMarkIcon } from '@lucide/svelte'
    import Tooltip from './Tooltip.svelte'

    let { text }: { text: string } = $props()
</script>

<Tooltip>
    {#snippet trigger(props)}
        <button
            {...props}
            type="button"
            class="ml-auto inline-flex items-center border-0 bg-transparent p-0 text-subtext"
            tabindex="-1"
            aria-label={text}
            onpointerdown={(event) => {
                event.preventDefault()
                event.stopPropagation()
            }}
            onclick={(event) => event.stopPropagation()}
        >
            <CircleQuestionMarkIcon />
        </button>
    {/snippet}
    {text}
</Tooltip>
