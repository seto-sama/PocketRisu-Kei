<script lang="ts">
    import { advancedSettingsItems } from "src/ts/setting/advancedSettingsData";
    import SettingRenderer from "../SettingRenderer.svelte";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import SettingTabs from "src/lib/UI/GUI/SettingTabs.svelte";
    import SettingLayout from "src/lib/Setting/Wrappers/SettingLayout.svelte";
    import { language } from "src/lang";

    let submenu = $state(0);

    const requestItemIds = new Set([
        'adv.retries',
        'adv.genTime',
        'adv.sayNothing',
        'adv.autoFill',
        'adv.antiOverload',
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
        'adv.promptTextInfo',
        'adv.allowExt',
        'adv.cssErr',
    ]);
    const developerPrimaryItemIds = [
        'adv.newImgBeta',
        'adv.allowV2Plugin',
        'adv.depTrig',
    ];
    const developerPrimaryItemIdSet = new Set(developerPrimaryItemIds);
    const developerWarningItemIds = new Set(['adv.warn']);
    const movedItemIds = new Set([...requestItemIds, ...lorebookItemIds, ...dataDisplayItemIds]);

    const requestSettingsItems = advancedSettingsItems.filter((item) => requestItemIds.has(item.id));
    const lorebookSettingsItems = advancedSettingsItems.filter((item) => lorebookItemIds.has(item.id));
    const dataDisplaySettingsItems = advancedSettingsItems.filter((item) => dataDisplayItemIds.has(item.id));
    const developerPrimarySettingsItems = advancedSettingsItems
        .filter((item) => developerPrimaryItemIdSet.has(item.id))
        .sort((a, b) => developerPrimaryItemIds.indexOf(a.id) - developerPrimaryItemIds.indexOf(b.id));
    const developerWarningItems = advancedSettingsItems.filter((item) => developerWarningItemIds.has(item.id));
    const developerSettingsItems = advancedSettingsItems.filter(
        (item) =>
            !movedItemIds.has(item.id) &&
            !developerPrimaryItemIdSet.has(item.id) &&
            !developerWarningItemIds.has(item.id)
    );
</script>

<SettingPage title={language.advancedSettings}>
<SettingTabs
    tabs={[
        { label: language.advancedRequestTab, value: 0 },
        { label: language.others, value: 1 },
    ]}
    bind:selected={submenu}
/>

{#if submenu === 0}
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
    <SettingLayout variant="section" title={language.developerSettings}>
        <SettingRenderer items={developerWarningItems} />
        <SettingRenderer items={developerPrimarySettingsItems} layout="row" />
        <SettingRenderer items={developerSettingsItems} />
    </SettingLayout>
{/if}
</SettingPage>
