<script lang="ts">
    import { language } from "src/lang";
    import { DBState, HotkeySubmenuIndex } from "src/ts/stores.svelte";
    import SettingLayout from "src/lib/Setting/Wrappers/SettingLayout.svelte";
    import SettingRenderer from "../SettingRenderer.svelte";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import SettingTabs from "src/lib/UI/GUI/SettingTabs.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import ShInput from "src/lib/UI/GUI/ShInput.svelte";
    import ShSwitch from "src/lib/UI/GUI/ShSwitch.svelte";
    import { hotkeyChatScreenItems } from "src/ts/setting/hotkeySettingsData";
    import { hotkeyActionGroups, isSupportedHotkey, type Hotkey } from "src/ts/defaulthotkeys";

    function orderedHotkeys(actions: readonly string[]) {
        return actions.flatMap((action) => {
            const hotkey = DBState.db.hotkeys.find((item) => item.action === action);
            return hotkey && isSupportedHotkey(hotkey) ? [hotkey] : [];
        });
    }

    let toolbarHotkeys = $derived(orderedHotkeys(hotkeyActionGroups.toolbar));
    let menuHotkeys = $derived(orderedHotkeys(hotkeyActionGroups.menu));
    let featureHotkeys = $derived(orderedHotkeys(hotkeyActionGroups.features));
    let sidebarHotkeys = $derived(orderedHotkeys(hotkeyActionGroups.sidebar));
    let chatInputHotkeys = $derived(orderedHotkeys(hotkeyActionGroups.chatInput));

    function formatHotkeyKey(key: string) {
        return key === ' ' ? 'SPACE' : (key?.toLocaleUpperCase() ?? '');
    }
</script>

{#snippet hotkeyRows(hotkeys: Hotkey[], firstBorderless: boolean)}
    {#each hotkeys as hotkey, index (hotkey.action)}
        <SettingLayout
            variant="row"
            title={language.hotkeyDesc[hotkey.action] ?? hotkey.action}
            className={index === 0 && firstBorderless ? '!border-t-0' : ''}
        >
                {#snippet control()}
                    {#if hotkey.disabled}
                        <div class="flex h-8 items-center">
                            <ShSwitch
                                checked={false}
                                ariaLabel={language.hotkeyDesc[hotkey.action] ?? hotkey.action}
                                onCheckedChange={(checked) => hotkey.disabled = !checked}
                            />
                        </div>
                    {:else}
                        <div class="flex items-center gap-2">
                            <ShButton
                                variant={hotkey.ctrl ? 'default' : 'outline'}
                                size="sm"
                                aria-pressed={hotkey.ctrl ?? false}
                                onclick={() => hotkey.ctrl = !hotkey.ctrl}
                            >
                                Ctrl
                            </ShButton>
                            <ShButton
                                variant={hotkey.shift ? 'default' : 'outline'}
                                size="sm"
                                aria-pressed={hotkey.shift ?? false}
                                onclick={() => hotkey.shift = !hotkey.shift}
                            >
                                Shift
                            </ShButton>
                            <ShButton
                                variant={hotkey.alt ? 'default' : 'outline'}
                                size="sm"
                                aria-pressed={hotkey.alt ?? false}
                                onclick={() => hotkey.alt = !hotkey.alt}
                            >
                                Alt
                            </ShButton>
                            <ShInput
                                value={formatHotkeyKey(hotkey.key)}
                                readonly
                                aria-label={`${language.hotkeyDesc[hotkey.action] ?? hotkey.action} ${language.hotkey}`}
                                className="h-8 min-h-8 w-24 text-center text-sm"
                                onkeydown={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    if (event.key === 'Backspace') {
                                        hotkey.disabled = true;
                                        return;
                                    }
                                    hotkey.key = event.key;
                                    hotkey.disabled = false;
                                }}
                            />
                        </div>
                    {/if}
                {/snippet}
        </SettingLayout>
    {/each}
{/snippet}

<SettingPage title={language.hotkey}>
    <SettingTabs
        tabs={[
            { label: language.sectionChatView, value: 0 },
            { label: language.others, value: 1 },
        ]}
        bind:selected={$HotkeySubmenuIndex}
    />

    {#if $HotkeySubmenuIndex === 0}
        <SettingLayout variant="section" title={language.hotkeyChatInput} first>
            <SettingRenderer items={hotkeyChatScreenItems} layout="row" />
            {@render hotkeyRows(chatInputHotkeys, false)}
        </SettingLayout>
        <SettingLayout variant="section" title={language.hotkeyToolbar}>
            {@render hotkeyRows(toolbarHotkeys, true)}
        </SettingLayout>
        <SettingLayout variant="section" title={language.accTabSidebar}>
            {@render hotkeyRows(sidebarHotkeys, true)}
        </SettingLayout>
    {:else}
        <SettingLayout variant="section" title={language.menu} first>
            {@render hotkeyRows(menuHotkeys, true)}
        </SettingLayout>
        <SettingLayout variant="section" title={language.hotkeyFeatures}>
            {@render hotkeyRows(featureHotkeys, true)}
        </SettingLayout>
    {/if}
</SettingPage>
