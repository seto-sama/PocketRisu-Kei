<script lang="ts">
    import { language } from 'src/lang'
    import { getCBSDocumentation, type CBSDocumentationItem } from 'src/ts/cbsDocumentation'
    import DocumentationList from 'src/lib/UI/DocumentationList.svelte'
    import Dialog from '../UI/components/Dialog.svelte'

    let { open = $bindable(false) }:{ open?:boolean } = $props()
    let documentation:CBSDocumentationItem[] = $state([])
    let initialized = $state(false)

    $effect(() => {
        if(open && !initialized){
            documentation = getCBSDocumentation()
            initialized = true
        }
    })
</script>

<Dialog
    bind:open
    size="xl"
    contentClass="h-[calc(100dvh-2rem)]"
    bodyClass="min-h-0 flex-1"
>
    {#snippet title()}{language.cbsDocumentationTitle}{/snippet}
    {#if initialized}
        <DocumentationList
            items={documentation}
            searchPlaceholder={language.cbsDocumentationSearchPlaceholder}
            aliasesLabel={language.cbsDocumentationAliases}
            emptyMessage={language.cbsDocumentationEmpty}
        />
    {:else}
        <p class="text-sm text-subtext">{language.loading}</p>
    {/if}
</Dialog>
