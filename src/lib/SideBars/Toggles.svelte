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
    import Accordion from '../UI/components/Accordion.svelte'
    import Button from "../UI/components/Button.svelte";
    import SettingsList, { type SettingsListSpacing } from "../UI/components/SettingsList.svelte";
    import Switch from "../UI/components/Switch.svelte";
    import Help from "../Others/Help.svelte";
    import Select from "../UI/components/Select.svelte";
    import SelectOption from "../UI/components/SelectOption.svelte";
    import Textarea from '../UI/components/Textarea.svelte'
    import Input from "../UI/components/Input.svelte";

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
        return templateUsesJailbreakToggle(DBState.db.promptTemplate)
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

    const toggleRowClass = 'rounded-md gap-0 px-0'
    const dirtyToggleControlClass = '!border-danger/40 !bg-danger/20 hover:!bg-danger/30 [&_[data-icon-button]]:!text-danger [&_svg]:!text-danger'

    function toggleControlClass(key: string, baseClass = ''): string {
        return isToggleDirty(key)
            ? `${baseClass} ${dirtyToggleControlClass}`
            : baseClass
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

{#snippet toggles(items: sidebarToggle[], reverse: boolean = false, spacing: SettingsListSpacing = 'spaced')}
    {#each items as toggle, index}
        {#if toggle.type === 'group' && toggle.children.length > 0}
            <div class={spacing === 'divided' ? 'w-full mt-2' : 'w-full'}>
                <Accordion name={toggle.value} variant="card">
                    <SettingsList {spacing}>
                        {@render toggles((toggle as sidebarToggleGroup).children, reverse, spacing)}
                    </SettingsList>
                </Accordion>
            </div>
        {:else if toggle.type === 'select'}
            <SettingsList variant="row" className={toggleRowClass}>
                {#if toggle.value?.trim()}
                    <span class="min-w-0 wrap-break-word pl-1 pr-2">{toggle.value}</span>
                {/if}
                <Select className={toggleControlClass(toggle.key, 'flex-1 min-w-0')} bind:value={DBState.db.globalChatVariables[`toggle_${toggle.key}`]}>
                    {#each toggle.options as option, i}
                        <SelectOption value={i.toString()}>{option}</SelectOption>
                    {/each}
                </Select>
            </SettingsList>
        {:else if toggle.type === 'text'}
            <SettingsList variant="row" className={toggleRowClass}>
                {#if toggle.value?.trim()}
                    <span class="min-w-0 wrap-break-word pl-1 pr-2">{toggle.value}</span>
                {/if}
                <Input className={toggleControlClass(toggle.key, 'flex-1 min-w-0')} bind:value={DBState.db.globalChatVariables[`toggle_${toggle.key}`]} />
            </SettingsList>
        {:else if toggle.type === 'textarea'}
            <SettingsList variant="row" align="start" className={toggleRowClass}>
                {#if toggle.value?.trim()}
                    <span class="min-w-0 wrap-break-word mt-1.5 pl-1 pr-2">{toggle.value}</span>
                {/if}
                <Textarea className={toggleControlClass(toggle.key, 'flex-1 min-w-0')} height='20' bind:value={DBState.db.globalChatVariables[`toggle_${toggle.key}`]} />
            </SettingsList>
        {:else if toggle.type === 'caption'}
            <div class="w-full mt-1 pl-1 text-xs text-subtext">
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
            <SettingsList variant="row" className={toggleRowClass}>
                {#if toggle.value?.trim()}
                    <span class="min-w-0 wrap-break-word pl-1 pr-2">{toggle.value}</span>
                {/if}
                <Switch
                    className={toggleControlClass(toggle.key, 'shrink-0')}
                    checked={DBState.db.globalChatVariables[`toggle_${toggle.key}`] === '1'}
                    onCheckedChange={(checked) => {
                        DBState.db.globalChatVariables[`toggle_${toggle.key}`] = checked ? '1' : '0'
                    }}
                />
            </SettingsList>
        {/if}
    {/each}
{/snippet}

{#if !DBState.db.disableToggleBinding}
<div class="text-[11px] text-subtext mt-4 px-1">{language.toggleBindingLabel}</div>
<div class="flex gap-1 mt-1 items-stretch">
    {#if isPinned}
        <span use:tooltip={language.togglePinRemove}>
            <Button variant="primary" size="icon" onclick={pinToChat}>
                <PinIcon />
            </Button>
        </span>
        <span class="flex-1 min-w-0 flex" use:tooltip={language.togglePinUpdate}>
            <Button
                variant={isDirty ? 'destructive' : 'default'}
                disabled={!isDirty}
                className="w-full"
                onclick={isDirty ? updatePin : undefined}
            >
                <SaveIcon class="shrink-0" />
                <span class="truncate">{isDirty ? dirtyCount : language.togglePinUpdateLabel}</span>
            </Button>
        </span>
    {:else}
        <span class="flex-1 min-w-0 flex" use:tooltip={language.togglePinToChat}>
            <Button className="w-full" onclick={pinToChat}>
                <PinIcon class="shrink-0" />
                <span class="truncate">{language.togglePinLabel}</span>
            </Button>
        </span>
    {/if}
    <span use:tooltip={language.togglePresetList}>
        <Button size="icon" onclick={openPresetList}>
            <FolderHeartIcon />
        </Button>
    </span>
</div>
{/if}

{#if !noContainer && groupedToggles.length > 4}
    <div class="h-48 border-darkborderc p-2 border rounded-sm flex flex-col items-start mt-2 overflow-y-auto">
        <SettingsList spacing="spaced">
            {#if hasJailbreakPrompt}
            <SettingsList variant="row" className="gap-0 px-0">
                <span class="min-w-0 wrap-break-word pl-1 pr-2">{language.jailbreakToggle}</span>
                <Switch className="shrink-0" bind:checked={DBState.db.jailbreakToggle} />
            </SettingsList>
            {/if}
            {@render toggles(groupedToggles, true, 'spaced')}
            {#if chara && DBState.db.hypaV3}
            <SettingsList variant="row" className="gap-0 px-0">
                <span class="flex items-center gap-1 pl-1 pr-2">
                    <span>{language.ToggleHypaMemory}</span>
                    <Help key="toggleHypaMemory" />
                </span>
                <Switch
                    checked={DBState.db.characters[$selectedCharID]?.chats?.[DBState.db.characters[$selectedCharID]?.chatPage]?.supaMemory ?? chara?.supaMemory ?? false}
                    onCheckedChange={() => {
                        const char = DBState.db.characters[$selectedCharID]
                        const chat = char?.chats?.[char.chatPage]
                        if (!chat) return
                        chat.supaMemory = !(chat.supaMemory ?? char.supaMemory ?? false)
                    }}
                />
            </SettingsList>
            {/if}
        </SettingsList>
    </div>
{:else}
    <SettingsList
        spacing="spaced"
        className={noContainer ? 'mt-2' : ''}
    >
        {#if hasJailbreakPrompt}
        <SettingsList variant="row" className="gap-0 px-0">
            <span class="min-w-0 wrap-break-word pl-1 pr-2">{language.jailbreakToggle}</span>
            <Switch className="shrink-0" bind:checked={DBState.db.jailbreakToggle} />
        </SettingsList>
        {/if}
        {@render toggles(groupedToggles, false, 'spaced')}
        {#if DBState.db.hypaV3}
        <SettingsList variant="row" className="gap-0 px-0">
            <span class="flex items-center gap-1 pl-1 pr-2">
                <span>{language.ToggleHypaMemory}</span>
                <Help key="toggleHypaMemory" />
            </span>
            <Switch
                checked={DBState.db.characters[$selectedCharID]?.chats?.[DBState.db.characters[$selectedCharID]?.chatPage]?.supaMemory ?? chara?.supaMemory ?? false}
                onCheckedChange={() => {
                    const char = DBState.db.characters[$selectedCharID]
                    const chat = char?.chats?.[char.chatPage]
                    if (!chat) return
                    chat.supaMemory = !(chat.supaMemory ?? char.supaMemory ?? false)
                }}
            />
        </SettingsList>
        {/if}
    </SettingsList>
{/if}
