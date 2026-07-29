<script lang="ts">
    import { alertConfirm, notifyError, notifySuccess } from "../../ts/alert";
    import { language } from "../../lang";
    import { DBState, modelPresetSelectCallback, settingsOpen } from 'src/ts/stores.svelte';
    import { get } from 'svelte/store';
    import { openSettings, SettingsRoute } from 'src/ts/routing';
    import ShButton from "../UI/GUI/ShButton.svelte";
    import { CopyIcon, PencilIcon, TrashIcon, XIcon } from "@lucide/svelte";
    import TextInput from "../UI/GUI/TextInput.svelte";
    import { v4 as uuidv4 } from "uuid";
    import ShSortableList from "../UI/GUI/ShSortableList.svelte";

    let editMode = $state(false)

    interface Props {
        close?: any;
    }

    let { close = () => {} }: Props = $props();

    // Clear any pending model-preset-select callback when the modal unmounts
    // so a stale callback can't fire on a later open.
    $effect(() => {
        return () => {
            modelPresetSelectCallback.set(null);
        };
    });

    function duplicatePreset(index: number) {
        const src = DBState.db.modelPresets[index];
        if (!src) return;
        const copy = safeStructuredClone(src);
        copy.id = uuidv4();
        copy.name = `${src.name} Copy`;
        copy.createdAt = Date.now();
        copy.updatedAt = Date.now();
        const presets = [...DBState.db.modelPresets, copy];
        DBState.db.modelPresets = presets;
        notifySuccess(language.presetDuplicated);
    }

    async function deletePreset(index: number) {
        const preset = DBState.db.modelPresets[index];
        if (!preset) return;
        const ok = await alertConfirm(`${language.removeConfirm}${preset.name}`);
        if (!ok) return;
        const next = [...DBState.db.modelPresets];
        next.splice(index, 1);
        DBState.db.modelPresets = next;
        notifySuccess(language.presetDeleted);
    }
</script>

<div class="absolute w-full h-full z-40 bg-black/50 flex justify-center items-center">
    <div class="bg-darkbg p-4 break-any rounded-md flex flex-col max-w-3xl w-124 max-h-full overflow-y-auto">
        <div class="flex items-center text-textcolor mb-4">
            <h2 class="mt-0 mb-0">{language.modelPresets}</h2>
            <div class="grow flex justify-end">
                <button class="text-textcolor2 hover:text-primary mr-2 cursor-pointer items-center" onclick={close}>
                    <XIcon size={20}/>
                </button>
            </div>
        </div>
        {#if !$settingsOpen}
            <ShButton variant="default" size="default" className="w-full mb-4" onclick={() => {
                close()
                openSettings(SettingsRoute.ModelPreset)
            }}>
                <PencilIcon/>
                <span class="ml-1">{language.presetEdit}</span>
            </ShButton>
        {/if}

        {#if DBState.db.modelPresets.length === 0}
            <div class="text-textcolor2 text-sm text-center py-8">
                {language.modelPresetEmpty}
            </div>
        {/if}

        <ShSortableList
            className="flex flex-col"
            disabled={editMode}
            onReorder={(orderedIds) => {
                const byId = new Map(DBState.db.modelPresets.map(preset => [preset.id, preset]));
                DBState.db.modelPresets = orderedIds
                    .map(id => byId.get(id))
                    .filter((preset) => preset !== undefined);
            }}
        >
        {#each DBState.db.modelPresets as preset, i (preset.id)}
            <button onclick={() => {
                if (!editMode) {
                    const cb = get(modelPresetSelectCallback)
                    if (cb) {
                        modelPresetSelectCallback.set(null)
                        cb(preset.id)
                        close()
                    }
                    // No callback = chat-binding flow never opened the modal.
                    // The menu page renders an inline library instead of opening
                    // this modal, so this branch shouldn't normally fire. Stay
                    // silent if it does (no active concept on ModelPreset).
                }
            }}
            data-sortable-key={preset.id}
            class="flex items-center text-textcolor border-t-1 border-solid border-0 border-darkborderc p-2 cursor-pointer"
            class:draggable-preset={!editMode}>
                {#if editMode}
                    <TextInput bind:value={DBState.db.modelPresets[i].name} placeholder="string" padding={false}/>
                {:else}
                    <span>{preset.name}</span>
                    {#if preset.profileSnapshot?.profileId}
                        <span class="text-textcolor2 text-xs ml-2 opacity-70">({preset.profileSnapshot.profileId})</span>
                    {/if}
                {/if}
                <div class="no-sort grow flex justify-end">
                    <div class="text-textcolor2 hover:text-primary cursor-pointer mr-2" role="button" tabindex="0" onclick={(e) => {
                        e.stopPropagation()
                        duplicatePreset(i)
                    }} onkeydown={(e) => {
                        if (e.key === 'Enter' && e.currentTarget instanceof HTMLElement) {
                            e.currentTarget.click()
                        }
                    }}>
                        <CopyIcon size={18}/>
                    </div>
                    <div class="text-textcolor2 hover:text-red-400 cursor-pointer" role="button" tabindex="0" onclick={(e) => {
                        e.stopPropagation()
                        deletePreset(i)
                    }} onkeydown={(e) => {
                        if (e.key === 'Enter' && e.currentTarget instanceof HTMLElement) {
                            e.currentTarget.click()
                        }
                    }}>
                        <TrashIcon size={18}/>
                    </div>
                </div>
            </button>
        {/each}
        </ShSortableList>

        <div class="flex mt-2 items-center">
            <!-- "+ 새로 만들기" — P2에서 registry profile browser 모달로 교체 -->
            <button class="text-textcolor2 hover:text-primary cursor-pointer" onclick={() => {
                editMode = !editMode
            }} aria-label="Toggle edit mode">
                <PencilIcon size={18}/>
            </button>
        </div>
    </div>
</div>

<style>
    .break-any{
        word-break: normal;
        overflow-wrap: anywhere;
    }
    .draggable-preset:hover {
        cursor: grab;
    }
    .draggable-preset:active {
        cursor: grabbing;
    }
</style>
