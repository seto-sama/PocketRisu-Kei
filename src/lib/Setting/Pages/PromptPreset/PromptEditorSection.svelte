<script lang="ts">
    import { language } from "src/lang";
    import { DBState } from "src/ts/stores.svelte";
    import Help from "src/lib/Others/Help.svelte";
    import DropList from "src/lib/SideBars/DropList.svelte";
    import PromptSettings from "../PromptSettings.svelte";
    import SettingRenderer from "../../SettingRenderer.svelte";
    import type { SettingItem } from "src/ts/setting/types";

    const legacyPromptItems: SettingItem[] = [
        { id: 'prompt.main', type: 'textarea', labelKey: 'mainPrompt', helpKey: 'mainprompt', bindKey: 'mainPrompt' },
        { id: 'prompt.jailbreak', type: 'textarea', labelKey: 'jailbreakPrompt', helpKey: 'jailbreak', bindKey: 'jailbreak' },
        { id: 'prompt.globalNote', type: 'textarea', labelKey: 'globalNote', helpKey: 'globalNote', bindKey: 'globalNote' },
    ];
</script>

{#if !DBState.db.promptTemplate}
    <SettingRenderer items={legacyPromptItems} layout="row" />
    <span class="text-textcolor mb-2 mt-4">{language.formatingOrder}<Help key="formatOrder"/></span>
    <DropList bind:list={DBState.db.formatingOrder} />
{:else}
    <PromptSettings mode='inline' />
{/if}
