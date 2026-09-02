<script lang="ts">
    import { language } from 'src/lang'
    import { getCBSDocumentation, type CBSDocumentationItem } from 'src/ts/cbsDocumentation'
    import DocumentationList from 'src/lib/UI/DocumentationList.svelte'
    import ShDialog from 'src/lib/UI/GUI/ShDialog.svelte'

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

<ShDialog
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
        <p class="text-sm text-textcolor2">{language.loading}</p>
    {/if}
</ShDialog>
