<script lang="ts">
    import type { triggerscript } from "src/ts/storage/database.svelte";
    import type { triggerCode } from "src/ts/process/triggers";
    import { language } from "src/lang";
    import { alertConfirm } from "src/ts/alert";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import { DBState } from "src/ts/stores.svelte";
    import type { Snippet } from "svelte";
    import { getTriggerScriptMode } from "./triggerScriptMode";

    interface Props {
        value?: triggerscript[];
        lowLevelAble?: boolean;
        header?: Snippet;
    }

    let { value = $bindable([]), lowLevelAble = false, header }: Props = $props();
    let triggerMode = $derived(getTriggerScriptMode(value))
    let v1Enabled = $derived(triggerMode === 'v1')
    let triggerV2LoadRevision = $state(0)
    let triggerV2ListPromise: Promise<typeof import("./TriggerV2List.svelte").default> | null = null
    let retryLabel = $derived((language as unknown as Record<string, string>).retry ?? 'Retry')

    const loadTriggerV1List = () => import("./TriggerV1List.svelte").then(m => m.default)
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
</script>

<div class="mt-2 flex items-center gap-2">
    {#if header}
        <div class="min-w-0">
            {@render header()}
        </div>
    {/if}
    <div class="flex items-center gap-2" class:ml-auto={!!header}>
    {#if v1Enabled || DBState.db.showDeprecatedTriggerV1 }
        <button class="border bg-bgcolor py-1 rounded-md text-sm px-2 text-textcolor {v1Enabled ? 'border-primary' : 'border-darkborderc'}" onclick={(async (e) => {
            e.stopPropagation()
            const codeType = value?.[0]?.effect?.[0]?.type
            if(codeType === 'triggercode' || codeType === 'triggerlua' || codeType === 'v2Header'){
                const t = await alertConfirm(language.triggerSwitchWarn)
                if(!t){
                    return
                }
                value = []
            }
        })}>V1</button>
    {/if}
    <button class="border bg-bgcolor py-1 rounded-md text-sm px-2 text-textcolor {triggerMode === 'v2' ? 'border-primary' : 'border-darkborderc'}" onclick={(async (e) => {
        e.stopPropagation()
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
    <button class="border bg-bgcolor py-1 rounded-md text-sm px-2 text-textcolor {triggerMode === 'lua' ? 'border-primary' : 'border-darkborderc'}" onclick={(async (e) => {
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
{#if v1Enabled}
    <span class="text-draculared">{language.triggerV1Warning}</span>
{/if}
{#if triggerMode === 'lua'}
    <TextAreaInput margin="both" autocomplete="off" bind:value={(value[0].effect[0] as triggerCode).code}></TextAreaInput>
{:else if triggerMode === 'v2'}
    {#await loadTriggerV2List(triggerV2LoadRevision)}
        <div class="mt-2 text-sm text-textcolor2">{language.loading}</div>
    {:then TriggerV2List}
        <TriggerV2List bind:value={value} lowLevelAble={lowLevelAble}/>
    {:catch error}
        <div class="mt-2 flex items-center gap-2 text-sm text-draculared">
            <span>{String(error)}</span>
            <button class="rounded-md border border-darkborderc px-2 py-1 text-textcolor hover:border-borderc" onclick={retryTriggerV2Load}>
                {retryLabel}
            </button>
        </div>
    {/await}
{:else}
    {#await loadTriggerV1List() then TriggerV1List}
        <TriggerV1List bind:value={value} lowLevelAble={lowLevelAble}/>
    {/await}
{/if}
