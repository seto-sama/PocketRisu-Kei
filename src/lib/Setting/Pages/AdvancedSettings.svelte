<script lang="ts">
    import { advancedSettingsItems } from "src/ts/setting/advancedSettingsData";
    import SettingRenderer from "../SettingRenderer.svelte";
    import SettingPage from "../../UI/components/SettingPage.svelte";
    import SettingTabs from "../../UI/components/SettingTabs.svelte";
    import SettingLayout from "src/lib/Setting/Wrappers/SettingLayout.svelte";
    import { language } from "src/lang";
    import { AdvancedSubmenuIndex } from "src/ts/stores.svelte";

    const requestItemIds = new Set([
        'adv.retries',
        'adv.outputRepetition',
        'adv.genTime',
        'adv.sayNothing',
        'adv.exp.cachePoint',
        'adv.toolUsage',
        'adv.simpleTool',
        'adv.banChar',
    ]);
    const lorebookItemIds = new Set([
        'adv.lbDepth',
        'adv.lbToken',
        'adv.disableLbRecursive',
        'adv.localActivationInCharacterLorebook',
        'adv.bulkEnabling',
    ]);
    const dataDisplayItemIds = new Set([
        'adv.requestInfo',
        'adv.promptInfo',
        'adv.allowExt',
        'adv.cssErr',
    ]);
    const laboratoryPrimaryItemIds = [
        'adv.newImgBeta',
        'adv.allowV2Plugin',
    ];
    const laboratoryPrimaryItemIdSet = new Set(laboratoryPrimaryItemIds);
    const laboratoryWarningItemIds = new Set(['adv.warn']);
    const movedItemIds = new Set([...requestItemIds, ...lorebookItemIds, ...dataDisplayItemIds]);

    const requestSettingsItems = advancedSettingsItems.filter((item) => requestItemIds.has(item.id));
    const lorebookSettingsItems = advancedSettingsItems.filter((item) => lorebookItemIds.has(item.id));
    const dataDisplaySettingsItems = advancedSettingsItems.filter((item) => dataDisplayItemIds.has(item.id));
    const laboratoryPrimarySettingsItems = advancedSettingsItems
        .filter((item) => laboratoryPrimaryItemIdSet.has(item.id))
        .sort((a, b) => laboratoryPrimaryItemIds.indexOf(a.id) - laboratoryPrimaryItemIds.indexOf(b.id));
    const laboratoryWarningItems = advancedSettingsItems.filter((item) => laboratoryWarningItemIds.has(item.id));
    const laboratorySettingsItems = advancedSettingsItems.filter(
        (item) =>
            !movedItemIds.has(item.id) &&
            !laboratoryPrimaryItemIdSet.has(item.id) &&
            !laboratoryWarningItemIds.has(item.id)
    );
</script>

<SettingPage title={language.advancedSettings}>
<SettingTabs
    tabs={[
        { label: language.advancedRequestTab, value: 0 },
        { label: language.others, value: 1 },
    ]}
    bind:selected={$AdvancedSubmenuIndex}
/>

{#if $AdvancedSubmenuIndex === 0}
    <SettingLayout variant="section" title={language.loreBook} first>
        <SettingRenderer items={lorebookSettingsItems} layout="row" />
    </SettingLayout>
    <SettingLayout variant="section" title={language.usageRequests}>
        <SettingRenderer items={requestSettingsItems} layout="row" />
    </SettingLayout>
{:else}
    <SettingLayout variant="section" title={language.dataDisplay} first>
        <SettingRenderer items={dataDisplaySettingsItems} layout="row" />
    </SettingLayout>
    <SettingLayout variant="section" title={language.laboratory}>
        <SettingRenderer items={laboratoryWarningItems} />
        <SettingRenderer items={[...laboratoryPrimarySettingsItems, ...laboratorySettingsItems]} layout="row" />
    </SettingLayout>
{/if}
</SettingPage>
