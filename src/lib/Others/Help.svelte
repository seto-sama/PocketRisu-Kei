<script lang="ts">
    import { TriangleAlert, FlaskConicalIcon, CircleQuestionMarkIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { parseMarkdownSafe } from "src/ts/parser/parser.svelte";
    import ShTooltip from "src/lib/UI/GUI/ShTooltip.svelte";

    interface Props {
        unrecommended?: boolean;
        key: (keyof (typeof language.help));
        name?: string;
    }

    let { unrecommended = false, key, name = '' }: Props = $props();
</script>

<ShTooltip className="[&_p]:m-0 [&_p+p]:mt-2 [&_ul]:my-2 [&_ul]:pl-4 [&_ul]:list-disc [&_ol]:my-2 [&_ol]:pl-4 [&_ol]:list-decimal [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_code]:break-words">
    {#snippet trigger(props)}
        <span
            {...props}
            role="button"
            tabindex="0"
            aria-label={`${name} ${language.showHelp}`.trim()}
            class="relative help ml-1 inline-flex size-4 shrink-0 items-center justify-center cursor-help hover:text-primary"
            style="vertical-align: -2px;"
            onclick={(event) => event.stopPropagation()}
        >
            {#if key === "experimental"}
                <span class="text-draculared hover:text-primary">
                    <FlaskConicalIcon size={16} />
                </span>
            {:else if unrecommended}
                <span class="text-draculared hover:text-primary">
                    <TriangleAlert size={12} />
                </span>
            {:else}
                <CircleQuestionMarkIcon size={12} />
            {/if}
        </span>
    {/snippet}
    {@html parseMarkdownSafe(language.help[key])}
</ShTooltip>
