<script lang="ts">
    import { getModuleToggles } from "src/ts/process/modules";
    import { DBState, selectedCharID } from "src/ts/stores.svelte";
    import { parseToggleSyntax, type sidebarToggle, type sidebarToggleGroup } from "src/ts/util";
    import { language } from "src/lang";
    import type { PromptItem } from "src/ts/process/prompt";
    import type { character } from "src/ts/storage/database.svelte";
    import { getCurrentChat, snapshotToggleValues, saveTogglesToChat } from "src/ts/storage/database.svelte";
    import { alertConfirm, alertTogglePresets, notifySuccess } from "src/ts/alert";
    import { tooltip } from "src/ts/gui/tooltip";
    import { PinIcon, SaveIcon, FolderHeartIcon } from "@lucide/svelte";
    import ShAccordion from '../UI/GUI/ShAccordion.svelte'
    import ShButton from "../UI/GUI/ShButton.svelte";
    import ShSettings, { type ShSettingsSpacing } from "../UI/GUI/ShSettings.svelte";
    import ShSwitch from "../UI/GUI/ShSwitch.svelte";
    import Help from "../Others/Help.svelte";
    import SelectInput from "../UI/GUI/SelectInput.svelte";
    import OptionInput from "../UI/GUI/OptionInput.svelte";
    import TextAreaInput from '../UI/GUI/TextAreaInput.svelte'
    import TextInput from "../UI/GUI/TextInput.svelte";

    interface Props {
        chara?: character
        noContainer?: boolean
    }

    let { chara = $bindable(), noContainer }: Props = $props();

    let currentChat = $derived(DBState.db.characters[$selectedCharID]?.chats?.[DBState.db.characters[$selectedCharID]?.chatPage])
    let isPinned = $derived(!DBState.db.disableToggleBinding && !!currentChat?.savedToggleValues)
    let dirtyCount = $derived.by(() => {
        if (DBState.db.disableToggleBinding) return 0
        const saved = currentChat?.savedToggleValues
        if (!saved) return 0
        const current = snapshotToggleValues()
        const allKeys = new Set([...Object.keys(saved), ...Object.keys(current)])
        const norm = (v: string | undefined) => v ?? ''
        let count = 0
        for (const key of allKeys) {
            if (norm(saved[key]) !== norm(current[key])) count++
        }
        return count
    })
    let isDirty = $derived(dirtyCount > 0)

    async function pinToChat() {
        const chat = getCurrentChat()
        if (!chat) return
        if (chat.savedToggleValues) {
            const confirmed = await alertConfirm(language.togglePinRemove)
            if (confirmed) {
                chat.savedToggleValues = undefined
                notifySuccess(language.togglePinUnbound)
            }
        } else {
            saveTogglesToChat()
            notifySuccess(language.togglePinSaved)
        }
    }

    function updatePin() {
        saveTogglesToChat()
        notifySuccess(language.togglePinSaved)
    }

    async function openPresetList() {
        await alertTogglePresets()
    }

    const jailbreakToggleToken = '{{jbtoggled}}'
    const usesJailbreakToggle = (value?: string) =>
        typeof value === 'string' && value.includes(jailbreakToggleToken)
    const templateUsesJailbreakToggle = (template: PromptItem[]) =>
        template.some(item => {
            if (item.type === 'jailbreak') {
                return true
            }
            if ('text' in item && usesJailbreakToggle(item.text)) {
                // plain, jailbreak, cot
                return true
            }
            if ('innerFormat' in item && usesJailbreakToggle(item.innerFormat)) {
                // persona, description, lorebook, postEverything, memory
                return true
            }
            if ('defaultText' in item && usesJailbreakToggle(item.defaultText)) {
                // author note
                return true
            }
            return false
        })

    let hasJailbreakPrompt = $derived.by(() => {
        const template = DBState.db.promptTemplate
        if (!template) {
            return (DBState.db.jailbreak ?? '').trim().length > 0
        }
        return templateUsesJailbreakToggle(template)
    })

    function isToggleDirty(key: string): boolean {
        if (DBState.db.disableToggleBinding) return false
        const saved = currentChat?.savedToggleValues
        if (!saved) return false
        const fullKey = `toggle_${key}`
        const current = DBState.db.globalChatVariables[fullKey] ?? undefined
        const savedVal = saved[fullKey] ?? undefined
        if (current === savedVal) return false
        const norm = (v: string | undefined) => v ?? ''
        return norm(current) !== norm(savedVal)
    }

    function toggleRowClass(key: string): string {
        return isToggleDirty(key)
            ? 'rounded-md bg-red-900 bg-opacity-15 gap-0 px-0'
            : 'rounded-md gap-0 px-0'
    }


    let groupedToggles = $derived.by(() => {
        // Track chat/module changes so the toggle list re-derives on chat switch
        const _char = DBState.db.characters[$selectedCharID]
        void _char?.chats?.[_char?.chatPage]?.modules
        void _char?.modules
        void DBState.db.enabledModules
        void DBState.db.moduleIntergration

        const ungrouped = parseToggleSyntax(
            DBState.db.customPromptTemplateToggle + '\n' +
            getModuleToggles() + '\n' +
            ((DBState.db?.characters?.[$selectedCharID] as character)?.customModuleToggle ?? '')
        )

        let groupOpen = false
        // group toggles together between group ... groupEnd
        return ungrouped.reduce<sidebarToggle[]>((acc, toggle) => {
            if (toggle.type === 'group') {
                groupOpen = true
                acc.push(toggle)
            } else if (toggle.type === 'groupEnd') {
                groupOpen = false
            } else if (groupOpen) {
                (acc.at(-1) as sidebarToggleGroup).children.push(toggle)
            } else {
                acc.push(toggle)
            }
            return acc
        }, [])
    })

</script>

{#snippet toggles(items: sidebarToggle[], reverse: boolean = false, spacing: ShSettingsSpacing = 'divided')}
    {#each items as toggle, index}
        {#if toggle.type === 'group' && toggle.children.length > 0}
            <div class={spacing === 'divided' ? 'w-full mt-2' : 'w-full'}>
                <ShAccordion name={toggle.value} variant="card">
                    <ShSettings {spacing}>
                        {@render toggles((toggle as sidebarToggleGroup).children, reverse, spacing)}
                    </ShSettings>
                </ShAccordion>
            </div>
        {:else if toggle.type === 'select'}
            <ShSettings variant="row" className={toggleRowClass(toggle.key)}>
                {#if toggle.value?.trim()}
                    <span class="min-w-0 wrap-break-word pl-1 pr-2">{toggle.value}</span>
                {/if}
                <SelectInput className="flex-1 min-w-0" bind:value={DBState.db.globalChatVariables[`toggle_${toggle.key}`]}>
                    {#each toggle.options as option, i}
                        <OptionInput value={i.toString()}>{option}</OptionInput>
                    {/each}
                </SelectInput>
            </ShSettings>
        {:else if toggle.type === 'text'}
            <ShSettings variant="row" className={toggleRowClass(toggle.key)}>
                {#if toggle.value?.trim()}
                    <span class="min-w-0 wrap-break-word pl-1 pr-2">{toggle.value}</span>
                {/if}
                <TextInput className="flex-1 min-w-0" bind:value={DBState.db.globalChatVariables[`toggle_${toggle.key}`]} />
            </ShSettings>
        {:else if toggle.type === 'textarea'}
            <ShSettings variant="row" align="start" className={toggleRowClass(toggle.key)}>
                {#if toggle.value?.trim()}
                    <span class="min-w-0 wrap-break-word mt-1.5 pl-1 pr-2">{toggle.value}</span>
                {/if}
                <TextAreaInput className="flex-1 min-w-0" height='20' bind:value={DBState.db.globalChatVariables[`toggle_${toggle.key}`]} />
            </ShSettings>
        {:else if toggle.type === 'caption'}
            <div class="w-full mt-1 pl-1 text-xs text-textcolor2">
                {toggle.value}
            </div>
        {:else if toggle.type === 'divider'}
            <!-- Prevent multiple dividers appearing in a row -->
            {#if index === 0 || items[index - 1]?.type !== 'divider' || items[index - 1]?.value !== toggle.value}
                <div class="w-full min-h-5 flex gap-2 mt-2 items-center" class:justify-end={!reverse}>
                    {#if toggle.value?.trim()}
                        <span class="shrink-0">{toggle.value}</span>
                    {/if}
                    <hr class="border-t border-darkborderc m-0 grow" />
                </div>
            {/if}
        {:else}
            <ShSettings variant="row" className={toggleRowClass(toggle.key)}>
                {#if toggle.value?.trim()}
                    <span class="min-w-0 wrap-break-word pl-1 pr-2">{toggle.value}</span>
                {/if}
                <ShSwitch
                    className="shrink-0"
                    checked={DBState.db.globalChatVariables[`toggle_${toggle.key}`] === '1'}
                    onCheckedChange={(checked) => {
                        DBState.db.globalChatVariables[`toggle_${toggle.key}`] = checked ? '1' : '0'
                    }}
                />
            </ShSettings>
        {/if}
    {/each}
{/snippet}

{#if !DBState.db.disableToggleBinding}
<div class="text-[11px] text-textcolor2 mt-4 px-1">{language.toggleBindingLabel}</div>
<div class="flex gap-1 mt-1 items-stretch">
    {#if isPinned}
        <span use:tooltip={language.togglePinRemove}>
            <ShButton variant="primary" size="icon" onclick={pinToChat}>
                <PinIcon />
            </ShButton>
        </span>
        <span class="flex-1 min-w-0 flex" use:tooltip={language.togglePinUpdate}>
            <ShButton
                variant={isDirty ? 'destructive' : 'default'}
                disabled={!isDirty}
                className="w-full"
                onclick={isDirty ? updatePin : undefined}
            >
                <SaveIcon class="shrink-0" />
                <span class="truncate">{isDirty ? dirtyCount : language.togglePinUpdateLabel}</span>
            </ShButton>
        </span>
    {:else}
        <span class="flex-1 min-w-0 flex" use:tooltip={language.togglePinToChat}>
            <ShButton className="w-full" onclick={pinToChat}>
                <PinIcon class="shrink-0" />
                <span class="truncate">{language.togglePinLabel}</span>
            </ShButton>
        </span>
    {/if}
    <span use:tooltip={language.togglePresetList}>
        <ShButton size="icon" onclick={openPresetList}>
            <FolderHeartIcon />
        </ShButton>
    </span>
</div>
{/if}

{#if !noContainer && groupedToggles.length > 4}
    <div class="h-48 border-darkborderc p-2 border rounded-sm flex flex-col items-start mt-2 overflow-y-auto">
        <ShSettings spacing="divided">
            {#if hasJailbreakPrompt}
            <ShSettings variant="row" className="gap-0 px-0">
                <span class="min-w-0 wrap-break-word pl-1 pr-2">{language.jailbreakToggle}</span>
                <ShSwitch className="shrink-0" bind:checked={DBState.db.jailbreakToggle} />
            </ShSettings>
            {/if}
            {@render toggles(groupedToggles, true, 'divided')}
            {#if chara && DBState.db.hypaV3}
            <ShSettings variant="row" className="gap-0 px-0">
                <span class="flex items-center gap-1 pl-1 pr-2">
                    <span>{language.ToggleHypaMemory}</span>
                    <Help key="toggleHypaMemory" />
                </span>
                <ShSwitch
                    checked={DBState.db.characters[$selectedCharID]?.chats?.[DBState.db.characters[$selectedCharID]?.chatPage]?.supaMemory ?? chara?.supaMemory ?? false}
                    onCheckedChange={() => {
                        const char = DBState.db.characters[$selectedCharID]
                        const chat = char?.chats?.[char.chatPage]
                        if (!chat) return
                        chat.supaMemory = !(chat.supaMemory ?? char.supaMemory ?? false)
                    }}
                />
            </ShSettings>
            {/if}
        </ShSettings>
    </div>
{:else}
    <ShSettings
        spacing={noContainer ? 'spaced' : 'divided'}
        className={noContainer ? 'mt-2' : ''}
    >
        {#if hasJailbreakPrompt}
        <ShSettings variant="row" className="gap-0 px-0">
            <span class="min-w-0 wrap-break-word pl-1 pr-2">{language.jailbreakToggle}</span>
            <ShSwitch className="shrink-0" bind:checked={DBState.db.jailbreakToggle} />
        </ShSettings>
        {/if}
        {@render toggles(groupedToggles, false, noContainer ? 'spaced' : 'divided')}
        {#if DBState.db.hypaV3}
        <ShSettings variant="row" className="gap-0 px-0">
            <span class="flex items-center gap-1 pl-1 pr-2">
                <span>{language.ToggleHypaMemory}</span>
                <Help key="toggleHypaMemory" />
            </span>
            <ShSwitch
                checked={DBState.db.characters[$selectedCharID]?.chats?.[DBState.db.characters[$selectedCharID]?.chatPage]?.supaMemory ?? chara?.supaMemory ?? false}
                onCheckedChange={() => {
                    const char = DBState.db.characters[$selectedCharID]
                    const chat = char?.chats?.[char.chatPage]
                    if (!chat) return
                    chat.supaMemory = !(chat.supaMemory ?? char.supaMemory ?? false)
                }}
            />
        </ShSettings>
        {/if}
    </ShSettings>
{/if}
