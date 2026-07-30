<script lang="ts">
    import SettingRenderer from "../../SettingRenderer.svelte";
    import SoundGroup from "../Sound/SoundGroup.svelte";
    import { alertClear, alertConfirm, alertStore, notifyError, notifySuccess } from "src/ts/alert";
    import { language } from "src/lang";
    import { DBState } from "src/ts/stores.svelte";
    import { emptyModelBinding, type ModelBindingSet } from "src/ts/preset/types";
    import ModelPresetList from "src/lib/UI/ModelPresetList.svelte";
    import SettingLayout from "src/lib/Setting/Wrappers/SettingLayout.svelte";
    import { requestImmediateSave } from "src/ts/globalApi.svelte";
    import {
        modelPresetOtherOptionsItems,
        modelPresetRegistryOptionsItems,
    } from "src/ts/setting/modelPresetOptionsData";
    import { fetchChatFromServer, saveChatToServer } from "src/ts/storage/chatStorage";

    function ensureDefaultBinding(): ModelBindingSet {
        DBState.db.defaultModelBinding ??= emptyModelBinding();
        const binding = DBState.db.defaultModelBinding;
        binding.main ??= '';
        binding.sub ??= '';
        binding.separateAux ??= false;
        binding.aux ??= { memory: '', emotion: '', translate: '', otherAx: '' };
        binding.aux.memory ??= '';
        binding.aux.emotion ??= '';
        binding.aux.translate ??= '';
        binding.aux.otherAx ??= '';
        return binding;
    }

    let defaultBinding = ensureDefaultBinding();
    const separateAuxItems = [{
        id: 'modelPreset.defaultBinding.separateAux',
        type: 'check' as const,
        labelKey: 'seperateModelsForAxModels',
        helpKey: 'modelPresetGlobalAuxBindingHelp',
        bindPath: 'separateAux',
    }];

    async function overwriteChatBindings(scope: 'main' | 'sub') {
        if (!(await alertConfirm(language.modelPresetOverwriteConfirm))) return;

        const source = $state.snapshot(ensureDefaultBinding());
        const targets = DBState.db.characters.flatMap((character) =>
            character.chats.map((chat, chatIndex) => ({ character, chat, chatIndex }))
        );
        let nextTarget = 0;
        let count = 0;
        const updateProgress = () => {
            alertStore.set({
                type: 'progress',
                msg: `${language.modelPresetOverwriteProgress} ${count}/${targets.length}`,
                submsg: (targets.length > 0 ? count / targets.length * 100 : 100).toFixed(1),
            });
        };

        try {
            updateProgress();
            const workers = Array.from({ length: Math.min(4, targets.length) }, async () => {
                while (nextTarget < targets.length) {
                    const target = targets[nextTarget++];
                    const { character, chat: chatSlot, chatIndex } = target;
                    let chat = chatSlot;
                    if (chatSlot._placeholder) {
                        if (!chatSlot.id) {
                            throw new Error(`Missing chat id while overwriting ${character.chaId} #${chatIndex}`);
                        }
                        const fullChat = await fetchChatFromServer(character.chaId, chatIndex, chatSlot.id);
                        if (!fullChat) {
                            throw new Error(`Failed to load chat while overwriting ${character.chaId}/${chatSlot.id}`);
                        }
                        chat = fullChat;
                    }
                    chat.modelBinding ??= emptyModelBinding();
                    if (scope === 'main') {
                        chat.modelBinding.main = source.main ?? '';
                    } else {
                        chat.modelBinding.sub = source.sub ?? '';
                        chat.modelBinding.separateAux = source.separateAux;
                        chat.modelBinding.aux = structuredClone(source.aux);
                    }
                    if (chatSlot._placeholder) {
                        await saveChatToServer(character.chaId, chatIndex, chatSlot.id!, chat);
                    }
                    count += 1;
                    updateProgress();
                }
            });
            const results = await Promise.allSettled(workers);
            if (count > 0) void requestImmediateSave();
            const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
            if (failed) throw failed.reason;

            notifySuccess(language.modelPresetOverwriteSuccess.replace('{count}', String(count)));
        } catch (error) {
            notifyError(error);
        } finally {
            alertClear();
        }
    }
</script>

<SoundGroup
    title={language.modelPresetGroupRegistry}
    className=""
    titleClass="text-base font-bold mt-2 mb-1"
>
    <SettingRenderer items={modelPresetRegistryOptionsItems} layout="row" />
</SoundGroup>

<SoundGroup title={language.modelPresetBindingGroup}>
    <div class="flex items-center justify-between gap-3 py-3">
        <div class="flex flex-col gap-0.5 min-w-0">
            <span class="text-sm text-textcolor">{language.modelPresetGlobalBinding}</span>
            <span class="text-xs text-textcolor2">{language.help.modelPresetGlobalBindingHelp}</span>
        </div>
        <ModelPresetList compact warnIfEmpty bind:value={defaultBinding.main} />
    </div>
    <div class="flex items-center justify-between gap-3 py-3 border-t border-darkborderc">
        <div class="flex flex-col gap-0.5 min-w-0">
            <span class="text-sm text-textcolor">{language.modelPresetGlobalSubBinding}</span>
            <span class="text-xs text-textcolor2">{language.help.modelPresetGlobalSubBindingHelp}</span>
        </div>
        <ModelPresetList compact warnIfEmpty bind:value={defaultBinding.sub} />
    </div>
    <div class="border-t border-darkborderc">
        <SettingRenderer items={separateAuxItems} target={defaultBinding} layout="row" />
    </div>
    {#if defaultBinding.separateAux}
        {#each [
            { label: language.axModelMemory, key: 'memory' as const },
            { label: language.axModelTranslate, key: 'translate' as const },
            { label: language.axModelEmotion, key: 'emotion' as const },
            { label: language.axModelOther, key: 'otherAx' as const },
        ] as aux}
            <div class="flex items-center justify-between gap-3 py-3 pl-4 border-t border-darkborderc">
                <span class="text-sm text-textcolor">{aux.label}</span>
                <ModelPresetList compact blankable bind:value={defaultBinding.aux[aux.key]} />
            </div>
        {/each}
    {/if}

    <SettingLayout
        variant="row"
        title={language.modelPresetOverwriteTitle}
        description={language.help.modelPresetOverwriteDesc}
        actions={[
            { label: language.modelPresetOverwriteModelShort, onclick: () => overwriteChatBindings('main') },
            { label: language.modelPresetOverwriteSubmodelShort, onclick: () => overwriteChatBindings('sub') },
        ]}
    />
</SoundGroup>

<SoundGroup title={language.modelPresetGroupOther}>
    <SettingRenderer items={modelPresetOtherOptionsItems} layout="row" />
</SoundGroup>
