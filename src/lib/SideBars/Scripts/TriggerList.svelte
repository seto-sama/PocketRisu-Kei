<script lang="ts">
    import type { triggerscript } from "src/ts/storage/database.svelte";
    import type { triggerCode } from "src/ts/process/triggers";
    import { language } from "src/lang";
    import { alertConfirm } from "src/ts/alert";
    import Textarea from "../../UI/components/Textarea.svelte";
    import type { Snippet } from "svelte";
    import { getDisplayedTriggerScriptMode, getTriggerScriptMode } from "./triggerScriptMode";
    import { hasDeprecatedTriggerV2, migrateTriggersToCurrentV2 } from "src/ts/process/triggerDeprecatedV2Migration";

    interface Props {
        value?: triggerscript[];
        lowLevelAble?: boolean;
        header?: Snippet;
    }

    let { value = $bindable([]), lowLevelAble = false, header }: Props = $props();
    let triggerMode = $derived(getTriggerScriptMode(value))
    let displayedTriggerMode = $derived(getDisplayedTriggerScriptMode(value))
    let needsV2Projection = $derived(triggerMode === 'v1' || hasDeprecatedTriggerV2(value))
    let projectedV2Value = $state<triggerscript[]>([])
    let projectionSource = $state.raw<triggerscript[] | null>(null)
    let projectionBaseline = $state('')
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

    // Legacy data is projected into the current V2 editor without changing storage.
    // The first actual editor mutation commits that projection.
    $effect(() => {
        if (!needsV2Projection) {
            projectionSource = null
            return
        }
        if (projectionSource === value) return
        projectionSource = value
        projectedV2Value = migrateTriggersToCurrentV2(value)
        projectionBaseline = JSON.stringify(projectedV2Value)
    })

    $effect(() => {
        if (!needsV2Projection || !projectionSource) return
        const current = JSON.stringify(projectedV2Value)
        if (current === projectionBaseline) return
        projectionBaseline = current
        value = safeStructuredClone(projectedV2Value)
        projectionSource = null
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
        if(needsV2Projection) return
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
        {#if needsV2Projection}
            <TriggerV2List bind:value={projectedV2Value} lowLevelAble={lowLevelAble}/>
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
