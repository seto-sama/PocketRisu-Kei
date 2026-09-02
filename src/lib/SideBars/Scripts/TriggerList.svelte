<script lang="ts">
    import type { triggerscript } from "src/ts/storage/database.svelte";
    import type { triggerCode } from "src/ts/process/triggers";
    import { language } from "src/lang";
    import { alertConfirm } from "src/ts/alert";
    import Textarea from "../../UI/components/Textarea.svelte";
    import type { Snippet } from "svelte";
    import { getDisplayedTriggerScriptMode, getTriggerScriptMode } from "./triggerScriptMode";
    import { migrateTriggerV1ToV2 } from "src/ts/process/triggerV1Migration";

    interface Props {
        value?: triggerscript[];
        lowLevelAble?: boolean;
        header?: Snippet;
    }

    let { value = $bindable([]), lowLevelAble = false, header }: Props = $props();
    let triggerMode = $derived(getTriggerScriptMode(value))
    let displayedTriggerMode = $derived(getDisplayedTriggerScriptMode(value))
    let legacyV2Value = $state<triggerscript[]>([])
    let legacySource = $state.raw<triggerscript[] | null>(null)
    let legacyBaseline = $state('')
    let triggerV2LoadRevision = $state(0)
    let triggerV2ListPromise: Promise<typeof import("./TriggerV2List.svelte").default> | null = null
    let retryLabel = $derived((language as unknown as Record<string, string>).retry ?? 'Retry')

    const loadTriggerV2List = async (_revision: number) => {
        try {
            triggerV2ListPromise ??= import("./TriggerV2List.svelte").then(m => m.default)
            return await triggerV2ListPromise
        } catch (error) {
            triggerV2ListPromise = null
            throw error
        }
    }

    const retryTriggerV2Load = () => {
        triggerV2ListPromise = null
        triggerV2LoadRevision += 1
    }

    // Persisted V1 data is projected into a V2 editor without changing storage.
    // The first actual editor mutation commits that projection as current V2.
    $effect(() => {
        if (triggerMode !== 'v1') {
            legacySource = null
            return
        }
        if (legacySource === value) return
        legacySource = value
        legacyV2Value = migrateTriggerV1ToV2(value)
        legacyBaseline = JSON.stringify(legacyV2Value)
    })

    $effect(() => {
        if (triggerMode !== 'v1' || !legacySource) return
        const current = JSON.stringify(legacyV2Value)
        if (current === legacyBaseline) return
        legacyBaseline = current
        value = safeStructuredClone(legacyV2Value)
        legacySource = null
    })
</script>

<div class="mt-2 flex items-center gap-2">
    {#if header}
        <div class="min-w-0">
            {@render header()}
        </div>
    {/if}
    <div class="flex items-center gap-2" class:ml-auto={!!header}>
    <button class="border bg-lightbg py-1 rounded-md text-sm px-2 text-maintext {displayedTriggerMode === 'v2' ? 'border-primary' : 'border-darkborderc'}" onclick={(async (e) => {
        e.stopPropagation()
        if(triggerMode === 'v1') return
        const codeType = value?.[0]?.effect?.[0]?.type
        if(codeType !== 'v2Header'){
            const t = await alertConfirm(language.triggerSwitchWarn)
            if(!t){
                return
            }
            value = [{
                comment: "",
                type: "manual",
                conditions: [],
                effect: [{
                    type: "v2Header",
                    code: "",
                    indent: 0
                }]
            }, {
                comment: "New Event",
                type: 'manual',
                conditions: [],
                effect: []
            }]
        }
    })}>V2</button>
    <button class="border bg-lightbg py-1 rounded-md text-sm px-2 text-maintext {triggerMode === 'lua' ? 'border-primary' : 'border-darkborderc'}" onclick={(async (e) => {
        e.stopPropagation()
        if(value?.[0]?.effect?.[0]?.type !== 'triggerlua'){
            if(value && value.length > 0){
                const t = await alertConfirm(language.triggerSwitchWarn)
                if(!t){
                    return
                }
            }
            value = [{
                comment: "",
                type: "start",
                conditions: [],
                effect: [{
                    type: "triggerlua",
                    code: ""
                }]
            }]
        }
    })}>Lua</button>
    </div>
</div>
{#if triggerMode === 'lua'}
    <Textarea margin="both" autocomplete="off" bind:value={(value[0].effect[0] as triggerCode).code}></Textarea>
{:else if displayedTriggerMode === 'v2'}
    {#await loadTriggerV2List(triggerV2LoadRevision)}
        <div class="mt-2 text-sm text-subtext">{language.loading}</div>
    {:then TriggerV2List}
        {#if triggerMode === 'v1'}
            <TriggerV2List bind:value={legacyV2Value} lowLevelAble={lowLevelAble}/>
        {:else}
            <TriggerV2List bind:value={value} lowLevelAble={lowLevelAble}/>
        {/if}
    {:catch error}
        <div class="mt-2 flex items-center gap-2 text-sm text-danger">
            <span>{String(error)}</span>
            <button class="rounded-md border border-darkborderc px-2 py-1 text-maintext risu-interactive-border" onclick={retryTriggerV2Load}>
                {retryLabel}
            </button>
        </div>
    {/await}
{:else}
    <Textarea margin="both" autocomplete="off" bind:value={(value[0].effect[0] as triggerCode).code}></Textarea>
{/if}
