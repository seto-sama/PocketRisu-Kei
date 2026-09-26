<script lang="ts">
    import SettingPage from "../../UI/components/SettingPage.svelte";
    import SettingTabs from "../../UI/components/SettingTabs.svelte";
    import { language } from "src/lang";
    import { DBState, OtherBotsSubmenuIndex, selectedCharID } from "src/ts/stores.svelte";
    import { untrack } from "svelte";
    import { tokenizePreset } from "src/ts/process/prompt";
    import { ChatTokenizer, getCharToken, getModelPresetChatTokenizerConfig } from "src/ts/tokenizer";
    import { getRecentContextToken, selectActiveChatMessages, type TokenizableChatMessage } from "src/ts/chatContextTokens";
    import HypaMemorySettings from "./HypaMemorySettings.svelte";
    import TTSSettings from "./TTSSettings.svelte";
    import ImageSettings from "./ImageSettings.svelte";
    import { resolveChatMaxContextTokens, resolveChatModelBinding } from "src/ts/process/request/modelPresetBinding";
    import { risuChatParser } from "src/ts/parser/parser.svelte";

    let { embedded = false }: { embedded?: boolean } = $props();

    $effect(() => {
        const settings = DBState.db.hypaV3Presets?.[DBState.db.hypaV3PresetId]?.settings;
        const currentValue = settings?.similarMemoryRatio;
        if (!currentValue) return;

        untrack(() => {
            const newValue = Math.min(currentValue, 1);
            settings.similarMemoryRatio = newValue;
            if (newValue + settings.recentMemoryRatio > 1) {
                settings.recentMemoryRatio = 1 - newValue;
            }
        });
    });

    $effect(() => {
        const settings = DBState.db.hypaV3Presets?.[DBState.db.hypaV3PresetId]?.settings;
        const currentValue = settings?.recentMemoryRatio;
        if (!currentValue) return;

        untrack(() => {
            const newValue = Math.min(currentValue, 1);
            settings.recentMemoryRatio = newValue;
            if (newValue + settings.similarMemoryRatio > 1) {
                settings.similarMemoryRatio = 1 - newValue;
            }
        });
    });

    async function getMaxMemoryRatio(): Promise<number> {
        const promptTemplate = DBState.db.promptTemplate;
        const char = DBState.db.characters[$selectedCharID];
        const chat = char?.chats?.[char.chatPage];
        if (!char || !chat) return 0;
        const settings = DBState.db.hypaV3Presets?.[DBState.db.hypaV3PresetId]?.settings;
        if (!settings) return 0;
        const maxLoreToken = char.loreSettings?.tokenBudget ?? DBState.db.loreBookToken;
        const binding = resolveChatModelBinding(chat, "model");
        const tokenizerConfig = getModelPresetChatTokenizerConfig(
            binding.kind === "modelPreset" ? binding.preset : undefined
        );
        const tokenizer = new ChatTokenizer(
            tokenizerConfig.chatAdditionalTokens,
            tokenizerConfig.useName,
            tokenizerConfig.tokenizer,
        );
        const selectedMessages = selectActiveChatMessages(chat, settings.queryChatCount);
        const recentCandidates: TokenizableChatMessage[] = [];
        const recentMessages = selectedMessages.messages;
        if (recentMessages.length < settings.queryChatCount
            && !selectedMessages.startsAfterCutoff && !chat.firstMessageDisabled) {
            const firstMessage = (chat.fmIndex ?? -1) === -1
                ? char.firstMessage
                : char.alternateGreetings[chat.fmIndex ?? 0];
            recentCandidates.push({
                role: "assistant",
                content: risuChatParser(firstMessage ?? "", { chara: char }),
            });
        }
        recentCandidates.push(...recentMessages.map(message => ({
            role: message.role === "user" ? "user" as const : "assistant" as const,
            content: risuChatParser(message.data, { chara: char, role: message.role }),
        })));
        const [promptTemplateToken, charToken] = await Promise.all([
            tokenizePreset(promptTemplate),
            getCharToken(char),
        ]);
        const recentChatToken = await getRecentContextToken(
            recentCandidates,
            settings.queryChatCount,
            tokenizer,
        );
        const requiredToken = promptTemplateToken
            + charToken.persistant
            + Math.min(charToken.dynamic, maxLoreToken)
            + recentChatToken;
        const maxContext = resolveChatMaxContextTokens(chat);
        if (maxContext === 0) return 0;
        return parseFloat(Math.max((maxContext - requiredToken) / maxContext, 0).toFixed(2));
    }

    const maxMemoryRatio = $derived.by(() => getMaxMemoryRatio());
</script>

<SettingPage title={embedded ? undefined : language.otherBots}>
    <SettingTabs tabs={[
        { label: language.longTermMemory, value: 0 },
        { label: 'TTS', value: 1 },
        { label: language.image, value: 2 },
    ]} bind:selected={$OtherBotsSubmenuIndex} />

    {#if $OtherBotsSubmenuIndex === 0}
        <HypaMemorySettings {maxMemoryRatio} />
    {:else if $OtherBotsSubmenuIndex === 1}
        <TTSSettings />
    {:else if $OtherBotsSubmenuIndex === 2}
        <ImageSettings />
    {/if}
</SettingPage>
