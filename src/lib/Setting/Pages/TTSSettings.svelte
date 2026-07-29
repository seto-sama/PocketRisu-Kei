<script lang="ts">
    import { language } from "src/lang";
    import ApiKeyModeControl, { getInitialApiKeyInputMode, type ApiKeyInputMode } from "src/lib/Setting/ApiKeyModeControl.svelte";
    import SettingLayout from "src/lib/Setting/Wrappers/SettingLayout.svelte";
    import ShSwitch from "src/lib/UI/GUI/ShSwitch.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import type { TTSApiKeyProvider } from "src/ts/storage/database.svelte";
    import { DBState } from "src/ts/stores.svelte";
    import { listApiKeys } from "src/ts/preset/apiKeyPool";

    const initialOpenAIKeyRef = DBState.db.ttsApiKeyRefs?.openai ?? '';
    const initialNovelAIKeyRef = DBState.db.ttsApiKeyRefs?.novelai ?? '';
    const initialElevenLabsKeyRef = DBState.db.ttsApiKeyRefs?.elevenlabs ?? '';
    const initialHuggingFaceKeyRef = DBState.db.ttsApiKeyRefs?.huggingface ?? '';
    const initialFishSpeechKeyRef = DBState.db.ttsApiKeyRefs?.fishspeech ?? '';
    let openAIKeyMode = $state<ApiKeyInputMode>(getInitialApiKeyInputMode(initialOpenAIKeyRef, DBState.db.openAIKey));
    let novelAIKeyMode = $state<ApiKeyInputMode>(getInitialApiKeyInputMode(initialNovelAIKeyRef, DBState.db.NAIApiKey));
    let elevenLabsKeyMode = $state<ApiKeyInputMode>(getInitialApiKeyInputMode(initialElevenLabsKeyRef, DBState.db.elevenLabKey));
    let huggingFaceKeyMode = $state<ApiKeyInputMode>(getInitialApiKeyInputMode(initialHuggingFaceKeyRef, DBState.db.huggingfaceKey));
    let fishSpeechKeyMode = $state<ApiKeyInputMode>(getInitialApiKeyInputMode(initialFishSpeechKeyRef, DBState.db.fishSpeechKey));

    const openAIKeys = $derived.by(() => {
        DBState.db.apiKeyPool;
        return listApiKeys('openai');
    });
    const novelAIKeys = $derived.by(() => {
        DBState.db.apiKeyPool;
        return listApiKeys('novelai');
    });
    const allKeys = $derived.by(() => {
        DBState.db.apiKeyPool;
        return listApiKeys();
    });
    const openAIKeyRef = $derived.by(() => {
        const ref = DBState.db.ttsApiKeyRefs?.openai ?? '';
        return openAIKeys.some((key) => key.id === ref) ? ref : '';
    });
    const novelAIKeyRef = $derived.by(() => {
        const ref = DBState.db.ttsApiKeyRefs?.novelai ?? '';
        return novelAIKeys.some((key) => key.id === ref) ? ref : '';
    });
    const elevenLabsKeyRef = $derived.by(() => {
        const ref = DBState.db.ttsApiKeyRefs?.elevenlabs ?? '';
        return allKeys.some((key) => key.id === ref) ? ref : '';
    });
    const huggingFaceKeyRef = $derived.by(() => {
        const ref = DBState.db.ttsApiKeyRefs?.huggingface ?? '';
        return allKeys.some((key) => key.id === ref) ? ref : '';
    });
    const fishSpeechKeyRef = $derived.by(() => {
        const ref = DBState.db.ttsApiKeyRefs?.fishspeech ?? '';
        return allKeys.some((key) => key.id === ref) ? ref : '';
    });

    function selectTTSKey(provider: TTSApiKeyProvider, value: string) {
        DBState.db.ttsApiKeyRefs = {
            ...(DBState.db.ttsApiKeyRefs ?? {}),
            [provider]: value || undefined,
        };
    }
</script>

<div class="flex flex-col w-full">
    <SettingLayout variant="section" title="TTS" first>
        <div class="[&>*:first-child]:border-t-0">
            <SettingLayout variant="row" title={language.ttsEnable} description={language.help.ttsEnable}>
                {#snippet control()}<ShSwitch bind:checked={DBState.db.ttsEnabled}/>{/snippet}
            </SettingLayout>
            {#if DBState.db.ttsEnabled}
                <SettingLayout variant="row" title={language.ttsAutoSpeech} description={language.help.ttsAutoSpeech}>
                    {#snippet control()}<ShSwitch bind:checked={DBState.db.ttsAutoSpeech}/>{/snippet}
                </SettingLayout>
            {/if}
        </div>
    </SettingLayout>

    {#if DBState.db.ttsEnabled}
        <SettingLayout variant="section" title={language.ttsSettings}>
            <div class="[&>*:first-child]:border-t-0">
                <SettingLayout variant="row" title={language.ttsElevenLabsApiKey} description={language.help.ttsElevenLabsKey}>
                    {#snippet control()}
                        <ApiKeyModeControl
                            bind:mode={elevenLabsKeyMode}
                            entries={allKeys}
                            selectedId={elevenLabsKeyRef}
                            bind:directValue={DBState.db.elevenLabKey}
                            onSelect={(id) => selectTTSKey('elevenlabs', id)}
                            showProvider
                        />
                    {/snippet}
                </SettingLayout>
                <SettingLayout variant="row" title={language.ttsVoicevoxUrl} description={language.help.ttsVoicevoxUrl}>
                    {#snippet control()}<TextInput className="w-48 text-sm" size="sm" bind:value={DBState.db.voicevoxUrl}/>{/snippet}
                </SettingLayout>

                <SettingLayout variant="row" title={language.openAIApiKey} description={language.help.ttsOpenAIKey}>
                    {#snippet control()}
                        <ApiKeyModeControl
                            bind:mode={openAIKeyMode}
                            entries={openAIKeys}
                            selectedId={openAIKeyRef}
                            bind:directValue={DBState.db.openAIKey}
                            onSelect={(id) => selectTTSKey('openai', id)}
                        />
                    {/snippet}
                </SettingLayout>

                <SettingLayout variant="row" title={language.novelAIApiKey} description={language.help.novelaiToken}>
                    {#snippet control()}
                        <ApiKeyModeControl
                            bind:mode={novelAIKeyMode}
                            entries={novelAIKeys}
                            selectedId={novelAIKeyRef}
                            bind:directValue={DBState.db.NAIApiKey}
                            onSelect={(id) => selectTTSKey('novelai', id)}
                            placeholder="pst-..."
                        />
                    {/snippet}
                </SettingLayout>

                <SettingLayout variant="row" title={language.ttsHuggingFaceApiKey} description={language.help.ttsHuggingfaceKey}>
                    {#snippet control()}
                        <ApiKeyModeControl
                            bind:mode={huggingFaceKeyMode}
                            entries={allKeys}
                            selectedId={huggingFaceKeyRef}
                            bind:directValue={DBState.db.huggingfaceKey}
                            onSelect={(id) => selectTTSKey('huggingface', id)}
                            placeholder="hf_..."
                            showProvider
                        />
                    {/snippet}
                </SettingLayout>
                <SettingLayout variant="row" title={language.ttsFishSpeechApiKey} description={language.help.ttsFishSpeechKey}>
                    {#snippet control()}
                        <ApiKeyModeControl
                            bind:mode={fishSpeechKeyMode}
                            entries={allKeys}
                            selectedId={fishSpeechKeyRef}
                            bind:directValue={DBState.db.fishSpeechKey}
                            onSelect={(id) => selectTTSKey('fishspeech', id)}
                            showProvider
                        />
                    {/snippet}
                </SettingLayout>
            </div>
        </SettingLayout>
    {/if}
</div>
