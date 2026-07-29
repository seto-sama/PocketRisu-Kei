<script lang="ts">
    import { language } from "src/lang";
    import { DBState } from "src/ts/stores.svelte";
    import SettingLayout from "src/lib/Setting/Wrappers/SettingLayout.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import ShInput from "src/lib/UI/GUI/ShInput.svelte";
    import ShSwitch from "src/lib/UI/GUI/ShSwitch.svelte";

    function formatHotkeyKey(key: string) {
        return key === ' ' ? 'SPACE' : (key?.toLocaleUpperCase() ?? '');
    }
</script>

<SettingLayout
    variant="row"
    title={language.enableHotkeys}
    description={language.enableHotkeysDesc}
    className="!border-t-0"
>
    {#snippet control()}
        <ShSwitch bind:checked={DBState.db.enableHotkeys} />
    {/snippet}
</SettingLayout>

{#if DBState.db.enableHotkeys}
    <SettingLayout
        variant="row"
        title={language.enableScrollToActiveChar}
        description={language.help.enableScrollToActiveChar}
    >
        {#snippet control()}
            <ShSwitch bind:checked={DBState.db.enableScrollToActiveChar} />
        {/snippet}
    </SettingLayout>

    <SettingLayout variant="section" title={language.hotkeyList}>
        {#each DBState.db.hotkeys as hotkey, index (hotkey.action)}
            <SettingLayout
                variant="row"
                title={language.hotkeyDesc[hotkey.action] ?? hotkey.action}
                className={index === 0 ? '!border-t-0' : ''}
            >
                {#snippet control()}
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
                                hotkey.key = event.key;
                            }}
                        />
                    </div>
                {/snippet}
            </SettingLayout>
        {/each}
    </SettingLayout>
{/if}
