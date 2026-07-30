<script lang="ts">
    import type { customscript } from "src/ts/storage/database.svelte";
    import RegexData from "./RegexData.svelte";
    import Sortable from "sortablejs";
    import { sleep, sortableOptions } from "src/ts/util";
    import { onDestroy, onMount } from "svelte";
    import ShDisclosureList from "src/lib/UI/GUI/ShDisclosureList.svelte";
    import { DownloadIcon, HardDriveUploadIcon, PlusIcon } from "@lucide/svelte";
    import { exportRegex, importRegex } from "src/ts/process/scripts";
    import IconButton from "src/lib/UI/GUI/IconButton.svelte";
    import IconButtonGroup from "src/lib/UI/GUI/IconButtonGroup.svelte";
    import type { IconButtonSize } from "src/lib/UI/GUI/IconButton.svelte";
    import {
        groupRegexScripts,
        removeRegexScriptGroup,
        reorderRegexScriptGroups,
        syncRegexScriptGroup,
        toggleRegexScriptType,
        type RegexScriptGroup,
    } from "./regexScriptGroups";
    interface Props {
        value?: customscript[];
        buttons?: boolean;
        embedded?: boolean;
        search?: string;
        actionIconSize?: IconButtonSize;
    }

    let {
        value = $bindable([]),
        buttons = false,
        embedded = false,
        search = '',
        actionIconSize = 'default',
    }: Props = $props();
    let stb: Sortable = null
    let ele: HTMLDivElement = $state()
    let sorted = $state(0)
    let openedScripts = $state(new Set<customscript>())
    let scriptGroups = $derived(groupRegexScripts(value))
    const createStb = () => {
        if (!ele || stb || search.trim()) return
        stb = Sortable.create(ele, {
            onEnd: async () => {
                let idx:number[] = []
                ele.querySelectorAll('[data-risu-idx]').forEach((e, i) => {
                    idx.push(parseInt(e.getAttribute('data-risu-idx')))
                })
                value = reorderRegexScriptGroups(scriptGroups, idx)
                try {
                    stb.destroy()
                } catch (error) {}
                stb = null
                sorted += 1
                await sleep(1)
                createStb()
            },
            ...sortableOptions,
            handle: '[data-disclosure-toggle]',
            animation: 150,
            chosenClass: 'risu-chosen-item',
            dragClass: 'risu-drag-item',
            ghostClass: 'risu-ghost-item',
        })
    }

    function matchesSearch(group: RegexScriptGroup) {
        const needle = search.trim().toLowerCase()
        if (!needle) return true
        const primary = group.scripts[0]
        return [primary.comment, primary.in, primary.out, ...group.scripts.map((script) => script.type)]
            .some((value) => String(value ?? '').toLowerCase().includes(needle))
    }

    $effect(() => {
        const searching = search.trim().length > 0
        if (searching && stb) {
            try {
                stb.destroy()
            } catch (error) {}
            stb = null
        } else if (!searching && ele && !stb) {
            createStb()
        }
    })

    onMount(createStb)

    onDestroy(() => {
        if(stb){
            try {
                stb.destroy()
            } catch (error) {}
        }
    })
</script>
{#key sorted}
    <ShDisclosureList className={embedded ? '' : 'mt-2'} bind:element={ele}>
        {#if scriptGroups.length === 0 || !scriptGroups.some(matchesSearch)}
            <div class="text-textcolor2 text-sm px-3 py-8 text-center">No Scripts</div>
        {/if}
        {#each scriptGroups as group}
            {@const customscript = group.scripts[0]}
            {#if matchesSearch(group)}
                <RegexData
                    {embedded}
                    {actionIconSize}
                    idx={group.indexes[0]}
                    value={customscript}
                    selectedTypes={group.scripts.map((script) => script.type)}
                    isOpen={openedScripts.has(customscript)}
                    onSharedChange={() => {
                        syncRegexScriptGroup(group)
                        value = [...value]
                    }}
                    onToggleType={(type) => {
                        value = toggleRegexScriptType(value, group, type)
                    }}
                    onOpen={() => {
                        openedScripts.add(customscript)
                        openedScripts = new Set(openedScripts)
                    }}
                    onClose={() => {
                        openedScripts.delete(customscript)
                        openedScripts = new Set(openedScripts)
                    }}
                    onRemove={() => {
                        openedScripts.delete(customscript)
                        openedScripts = new Set(openedScripts)
                        value = removeRegexScriptGroup(value, group)
                    }} />
            {/if}
        {/each}
    </ShDisclosureList>
{/key}
{#if buttons}
    <IconButtonGroup size={actionIconSize} className="mt-2">
        <IconButton onclick={() => {
            value = [...value, {
                comment: "",
                in: "",
                out: "",
                type: "editinput"
            }]
        }}>
            <PlusIcon />
        </IconButton>
        <IconButton onclick={() => {
            exportRegex(value)
        }}><DownloadIcon /></IconButton>
        <IconButton onclick={async () => {
            value = await importRegex(value)
        }}><HardDriveUploadIcon /></IconButton>
    </IconButtonGroup>
{/if}
