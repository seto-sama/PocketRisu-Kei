<script lang="ts">
    import { devToolAutopilotStore, requestPreviewOpen, selectedCharID } from "src/ts/stores.svelte";
    import Input from "../UI/components/Input.svelte";
    import NumberInput from "../UI/components/NumberInput.svelte";
    import { previewChatGuardToast, previewPersistFailureToast } from "src/ts/globalApi.svelte";
    import { alertConfirm, alertMd } from "src/ts/alert";
    import Accordion from "../UI/components/Accordion.svelte";
    import Button from "../UI/components/Button.svelte";
    import IconButton from "../UI/components/IconButton.svelte";
    import IconButtonGroup from "../UI/components/IconButtonGroup.svelte";
    import { getChatToken, tokenize } from "src/ts/tokenizer";
    import { tokenizePreset } from "src/ts/process/prompt";
    
    import { DBState } from 'src/ts/stores.svelte';
    import { language } from 'src/lang';
    import SettingsList from "../UI/components/SettingsList.svelte";
    import Textarea from "../UI/components/Textarea.svelte";
    import { ArrowDownIcon, ArrowUpIcon, BookOpenIcon, ChevronRightIcon, FileSearchIcon, UploadIcon, PlusIcon, SearchIcon, TrashIcon } from "@lucide/svelte";
    import { selectSingleFile } from "src/ts/util";
    import { doingChat, sendChat } from "src/ts/process/index.svelte";
    import { loadLoreBookV3Prompt } from "src/ts/process/lorebook.svelte";
    import { risuChatParser } from "src/ts/process/scripts";
    import { getModules } from "src/ts/process/modules";

    async function getCharacterDescriptionToken() {
        const char = DBState.db.characters[$selectedCharID]
        return tokenize(risuChatParser(char.desc, { chara: char }))
    }

    async function getActiveLorebookToken() {
        const char = DBState.db.characters[$selectedCharID]
        const result = await loadLoreBookV3Prompt({
            includeModuleLorebooks: false,
            updateActivationState: false,
        })
        const counts = await Promise.all(result.actives.map((lore) =>
            tokenize(risuChatParser(lore.prompt, { chara: char }))
        ))
        return counts.reduce((sum, count) => sum + count, 0)
    }

    function moveAutopilotItem(index: number, offset: -1 | 1) {
        const target = index + offset
        if (target < 0 || target >= $devToolAutopilotStore.length) return
        const next = [...$devToolAutopilotStore]
        const current = next[index]
        next[index] = next[target]
        next[target] = current
        $devToolAutopilotStore = next
    }

    function removeAutopilotItem(index: number) {
        $devToolAutopilotStore = $devToolAutopilotStore.filter((_, itemIndex) => itemIndex !== index)
    }

    async function importAutopilot() {
        const selected = await selectSingleFile(['txt', 'csv', 'json'])
        if (!selected) return

        const file = new TextDecoder().decode(selected.data)
        if (selected.name.endsWith('.json')) {
            const parsed = JSON.parse(file)
            if (Array.isArray(parsed)) {
                $devToolAutopilotStore = parsed.filter((item): item is string => typeof item === 'string')
            }
        } else if (selected.name.endsWith('.csv')) {
            $devToolAutopilotStore = file.split('\n').map((item) =>
                item.replace(/\r/g, '')
                    .replace(/\\n/g, '\n')
                    .replace(/\\t/g, '\t')
                    .replace(/\\r/g, '\r')
            )
        } else if (selected.name.endsWith('.txt')) {
            $devToolAutopilotStore = file.split('\n')
        }
    }

    async function runAutopilot() {
        if ($doingChat) return
        try {
            for (let i = 0; i < $devToolAutopilotStore.length; i++) {
                const db = DBState.db
                const currentChar = db.characters[$selectedCharID]
                const currentChat = currentChar.chats[currentChar.chatPage]
                currentChat.message.push({
                    role: 'user',
                    data: $devToolAutopilotStore[i],
                })
                currentChar.chats[currentChar.chatPage] = currentChat
                db.characters[$selectedCharID] = currentChar

                const generated = await sendChat(i)
                doingChat.set(false)
                if (!generated) return
            }
        } finally {
            // sendChat's normal UI caller clears this flag, but DevTool invokes
            // it directly. Always release it so the next autopilot turn and the
            // chat composer can proceed, including after an exception.
            doingChat.set(false)
        }
    }
</script>

{#snippet tokenRow(label: string, value: string)}
    <SettingsList variant="row" size="compact">
        <span class="min-w-0 flex-1 truncate text-base">{label}</span>
        <span class="shrink-0 text-sm leading-5 text-subtext tabular-nums">{value}</span>
    </SettingsList>
{/snippet}

<Accordion name={language.chatVariables}>
    <SettingsList spacing="none">
        {#if DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].scriptstate &&  Object.keys(DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].scriptstate).length > 0}
            {#each Object.keys(DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].scriptstate) as key}
                <SettingsList
                    variant="row"
                    size="compact"
                    layout="grid"
                    className="grid-cols-[minmax(0,1fr)_minmax(0,1fr)_1.5rem] gap-1 px-0"
                >
                    <span class="min-w-0 truncate pl-1 text-sm">{key}</span>
                    <div class="min-w-0 flex-1">
                        {#if typeof DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].scriptstate[key] === "object"}
                            <div class="text-center text-sm text-subtext">Object</div>
                        {:else if typeof DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].scriptstate[key] === "string"}
                            <Input size="sm" className="box-border h-6 min-w-0 max-w-full w-full" bind:value={DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].scriptstate[key] as string} />
                        {:else if typeof DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].scriptstate[key] === "number"}
                            <NumberInput size="sm" className="box-border h-6 min-w-0 max-w-full w-full" bind:value={DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].scriptstate[key] as number} />
                        {/if}
                    </div>
                    <button
                        type="button"
                        class="relative flex size-6 shrink-0 items-center justify-center text-subtext transition-colors after:absolute after:-inset-1 risu-interactive-danger"
                        aria-label={language.remove}
                        title={language.remove}
                        onclick={async () => {
                            if (!await alertConfirm(`${language.removeConfirm}${key}`)) return
                            delete DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].scriptstate[key]
                        }}
                    >
                        <TrashIcon size={16} />
                    </button>
                </SettingsList>
            {/each}
        {:else}
            <div class="p-2 text-center text-subtext">No variables</div>
        {/if}
    </SettingsList>
</Accordion>

<Accordion class="mt-2" name={language.tokens}>
    <SettingsList spacing="none">
        {#await getCharacterDescriptionToken()}
            {@render tokenRow(language.devToolTokens.characterProfile, language.devToolTokens.loading)}
        {:then token}
            {@render tokenRow(language.devToolTokens.characterProfile, `${token} ${language.tokens}`)}
        {/await}
        {#await getActiveLorebookToken()}
            {@render tokenRow(language.devToolTokens.activeLorebook, language.devToolTokens.loading)}
        {:then token}
            {@render tokenRow(language.devToolTokens.activeLorebook, `${token} ${language.tokens}`)}
        {/await}
        {#await getChatToken(DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage])}
            {@render tokenRow(language.devToolTokens.currentChat, language.devToolTokens.loading)}
        {:then token}
            {@render tokenRow(language.devToolTokens.currentChat, `${token} ${language.tokens}`)}
        {/await}
        {#if DBState.db.promptTemplate}
            {#await tokenizePreset(DBState.db.promptTemplate)}
                {@render tokenRow(language.devToolTokens.promptTemplate, language.devToolTokens.loading)}
            {:then token}
                {@render tokenRow(language.devToolTokens.promptTemplate, `${token} ${language.tokens}`)}
            {/await}
        {/if}
    </SettingsList>
    <span class="mt-2 block text-xs leading-4 text-subtext">{language.devToolTokens.estimateNotice}</span>
</Accordion>

<Accordion class="mt-2" name={language.autopilot}>
    {#if $devToolAutopilotStore.length === 0}
        <span class="text-sm text-subtext">{language.noData}</span>
    {/if}
    {#each $devToolAutopilotStore as _, i}
        <div class="mt-2 flex items-center gap-1">
            <div class="min-w-0 flex-1">
                <Textarea bind:value={$devToolAutopilotStore[i]} commitMode="input" placeholder="..." fullwidth />
            </div>
            <IconButtonGroup size="sm" direction="vertical">
                <IconButton
                    disabled={i === 0}
                    aria-label="Move up"
                    onclick={() => moveAutopilotItem(i, -1)}
                >
                    <ArrowUpIcon />
                </IconButton>
                <IconButton
                    disabled={i === $devToolAutopilotStore.length - 1}
                    aria-label="Move down"
                    onclick={() => moveAutopilotItem(i, 1)}
                >
                    <ArrowDownIcon />
                </IconButton>
                <IconButton
                    tone="destructive"
                    aria-label={language.remove}
                    onclick={() => removeAutopilotItem(i)}
                >
                    <TrashIcon />
                </IconButton>
            </IconButtonGroup>
        </div>
    {/each}
    <div class="mt-2 flex items-center justify-between">
        <IconButtonGroup>
            <IconButton
                aria-label={language.add}
                title={language.add}
                onclick={() => { $devToolAutopilotStore = [...$devToolAutopilotStore, ''] }}
            >
                <PlusIcon />
            </IconButton>
            <IconButton
                aria-label={language.import}
                title={language.import}
                onclick={importAutopilot}
            >
                <UploadIcon />
            </IconButton>
        </IconButtonGroup>
        <Button
            variant="outline"
            size="sm"
            disabled={$devToolAutopilotStore.length === 0 || $doingChat}
            onclick={runAutopilot}
        >
            {language.run}
        </Button>
    </div>
</Accordion>


<Accordion class="mt-2" name={language.preview}>
    <SettingsList spacing="none">
        <SettingsList variant="row" className="px-0">
            <Button
                variant="ghost"
                className="w-full justify-start px-1"
                onclick={() => requestPreviewOpen.set(true)}
            >
                <FileSearchIcon class="text-subtext" />
                <span class="min-w-0 flex-1 truncate text-left">{language.devToolPreview.request}</span>
                <ChevronRightIcon class="text-subtext" />
            </Button>
        </SettingsList>
        <SettingsList variant="row" className="px-0">
            <Button
                variant="ghost"
                className="w-full justify-start px-1"
                onclick={async () => {
                    const lorebookResult = await loadLoreBookV3Prompt()
                    const html = `
                    ${lorebookResult.actives.map((v) => {
                        return `## ${v.source}\n\n\`\`\`\n${v.prompt}\n\`\`\`\n`
                    }).join('\n')}
                    `.trim()
                    alertMd(html)
                }}
            >
                <BookOpenIcon class="text-subtext" />
                <span class="min-w-0 flex-1 truncate text-left">{language.devToolPreview.active}</span>
                <ChevronRightIcon class="text-subtext" />
            </Button>
        </SettingsList>
        <SettingsList variant="row" className="px-0">
            <Button
                variant="ghost"
                className="w-full justify-start px-1"
                onclick={async () => {
                    const lorebookResult = await loadLoreBookV3Prompt()
                    const html = `
                    <table>
                        <thead>
                            <tr>
                                <th>${language.devToolPreview.keyword}</th>
                                <th>${language.devToolPreview.source}</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${lorebookResult.matchLog.map((v) => {
                                return `<tr>
                                    <td><pre>${v.activated.trim()}</pre></td>
                                    <td><pre>${v.source.trim()}</pre></td>
                                </tr>`
                            }).join('\n')}
                        </tbody>
                    </table>
                    `.trim()
                    alertMd(html)
                }}
            >
                <SearchIcon class="text-subtext" />
                <span class="min-w-0 flex-1 truncate text-left">{language.devToolPreview.matches}</span>
                <ChevronRightIcon class="text-subtext" />
            </Button>
        </SettingsList>
    </SettingsList>
</Accordion>
