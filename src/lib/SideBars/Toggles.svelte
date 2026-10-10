<script lang="ts">
    import { DBState, selectedCharID } from "src/ts/stores.svelte";
    import { parseToggleSyntax, type sidebarToggle, type sidebarToggleGroup } from "src/ts/util";
    import { language } from "src/lang";
    import type { PromptItem } from "src/ts/process/prompt";
    import { getToggleTemplate, initializeToggleValues, saveTogglesToChat } from "src/ts/storage/database.svelte";
    import { alertConfirm, alertTogglePresets, notifySuccess } from "src/ts/alert";
    import { PinIcon, SaveIcon, FolderHeartIcon } from "@lucide/svelte";
    import Accordion from '../UI/components/Accordion.svelte'
    import Button from "../UI/components/Button.svelte";
    import SettingsList from "../UI/components/SettingsList.svelte";
    import Switch from "../UI/components/Switch.svelte";
    import Help from "../Others/Help.svelte";
    import Select from "../UI/components/Select.svelte";
    import SelectOption from "../UI/components/SelectOption.svelte";
    import Textarea from '../UI/components/Textarea.svelte'
    import Input from "../UI/components/Input.svelte";
    import Tooltip from "../UI/components/Tooltip.svelte";

    let currentCharacter = $derived(DBState.db.characters[$selectedCharID])
    let currentChat = $derived(currentCharacter?.chats?.[currentCharacter.chatPage])
    let isPinned = $derived(!DBState.db.disableToggleBinding && !!currentChat?.savedToggleValues)
    let parsedToggles = $derived(parseToggleSyntax(getToggleTemplate(DBState.db, currentCharacter, currentChat)))
    $effect(() => {
        initializeToggleValues(DBState.db, currentCharacter, currentChat)
    })
    let dirtyToggleKeys = $derived.by(() => {
        const saved = isPinned ? currentChat?.savedToggleValues : undefined
        return new Set(saved
            ? Object.keys(saved).filter(key => DBState.db.globalChatVariables[key] !== saved[key])
            : [])
    })
    let dirtyCount = $derived(dirtyToggleKeys.size)
    let isDirty = $derived(dirtyCount > 0)

    async function pinToChat() {
        const chat = currentChat
        if (!chat) return
        if (chat.savedToggleValues) {
            const confirmed = await alertConfirm(language.togglePinRemove)
            if (confirmed) {
                chat.savedToggleValues = undefined
                notifySuccess(language.togglePinUnbound)
            }
        } else {
            updatePin()
        }
    }

    function updatePin() {
        saveTogglesToChat()
        notifySuccess(language.togglePinSaved)
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

    const toggleRowClass = 'rounded-md gap-0 px-0'
    const dirtyToggleControlClass = '!border-danger/40 !bg-danger/20 hover:!bg-danger/30 [&_[data-icon-button]]:!text-danger [&_svg]:!text-danger'

    function toggleControlClass(key: string, baseClass = ''): string {
        return dirtyToggleKeys.has(`toggle_${key}`)
            ? `${baseClass} ${dirtyToggleControlClass}`
            : baseClass
    }


    let groupedToggles = $derived.by(() => {
        let groupOpen = false
        // group toggles together between group ... groupEnd
        return parsedToggles.reduce<sidebarToggle[]>((acc, toggle) => {
            if (toggle.type === 'group') {
                groupOpen = true
                acc.push({ ...toggle, children: [] })
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

{#snippet toggles(items: sidebarToggle[])}
    {#each items as toggle, index}
        {#if toggle.type === 'group' && toggle.children.length > 0}
            <div class="w-full">
                <Accordion name={toggle.value} variant="card">
                    <SettingsList spacing="spaced">
                        {@render toggles((toggle as sidebarToggleGroup).children)}
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
                <div class="w-full min-h-5 flex gap-2 mt-2 items-center justify-end">
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
{/if}
<div class="flex gap-1 mt-1 items-stretch" class:justify-end={DBState.db.disableToggleBinding}>
    {#if isPinned}
        <Tooltip>
            {#snippet trigger(props)}
                <span {...props}>
                    <Button variant="primary" size="icon" onclick={pinToChat}>
                        <PinIcon />
                    </Button>
                </span>
            {/snippet}
            {language.togglePinRemove}
        </Tooltip>
        <Tooltip>
            {#snippet trigger(props)}
                <span {...props} class="flex-1 min-w-0 flex">
                    <Button
                        variant={isDirty ? 'destructive' : 'default'}
                        disabled={!isDirty}
                        className="w-full"
                        onclick={updatePin}
                    >
                        <SaveIcon class="shrink-0" />
                        <span class="truncate">{isDirty ? dirtyCount : language.togglePinUpdateLabel}</span>
                    </Button>
                </span>
            {/snippet}
            {language.togglePinUpdate}
        </Tooltip>
    {:else if !DBState.db.disableToggleBinding}
        <Tooltip>
            {#snippet trigger(props)}
                <span {...props} class="flex-1 min-w-0 flex">
                    <Button className="w-full" onclick={pinToChat}>
                        <PinIcon class="shrink-0" />
                        <span class="truncate">{language.togglePinLabel}</span>
                    </Button>
                </span>
            {/snippet}
            {language.togglePinToChat}
        </Tooltip>
    {/if}
    <Tooltip>
        {#snippet trigger(props)}
            <span {...props}>
                <Button size="icon" onclick={alertTogglePresets}>
                    <FolderHeartIcon />
                </Button>
            </span>
        {/snippet}
        {language.togglePresetList}
    </Tooltip>
</div>

<SettingsList spacing="spaced" className="mt-2">
    {#if hasJailbreakPrompt}
    <SettingsList variant="row" className="gap-0 px-0">
        <span class="min-w-0 wrap-break-word pl-1 pr-2">{language.jailbreakToggle}</span>
        <Switch className="shrink-0" bind:checked={DBState.db.jailbreakToggle} />
    </SettingsList>
    {/if}
    {@render toggles(groupedToggles)}
    {#if currentCharacter && DBState.db.hypaV3}
        <SettingsList variant="row" className="gap-0 px-0">
            <span class="flex items-center gap-1 pl-1 pr-2">
                <span>{language.ToggleHypaMemory}</span>
                <Help key="toggleHypaMemory" />
            </span>
            <Switch
                checked={currentChat?.supaMemory ?? currentCharacter.supaMemory ?? false}
                onCheckedChange={() => {
                    if (!currentChat) return
                    currentChat.supaMemory = !(currentChat.supaMemory ?? currentCharacter.supaMemory ?? false)
                }}
            />
        </SettingsList>
    {/if}
</SettingsList>
