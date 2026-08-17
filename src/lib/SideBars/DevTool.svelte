<script lang="ts">
    import { devToolAutopilotStore, selectedCharID } from "src/ts/stores.svelte";
    import TextInput from "../UI/GUI/TextInput.svelte";
    import NumberInput from "../UI/GUI/NumberInput.svelte";
    import { previewChatGuardToast, previewPersistFailureToast } from "src/ts/globalApi.svelte";
    import { alertConfirm, alertMd, alertWait } from "src/ts/alert";
    import Accordion from "../UI/Accordion.svelte";
    import ShButton from "../UI/GUI/ShButton.svelte";
    import IconButton from "../UI/GUI/IconButton.svelte";
    import IconButtonGroup from "../UI/GUI/IconButtonGroup.svelte";
    import { getChatToken, tokenize } from "src/ts/tokenizer";
    import { tokenizePreset } from "src/ts/process/prompt";
    
    import { DBState } from 'src/ts/stores.svelte';
    import { language } from 'src/lang';
    import ShSettings from "../UI/GUI/ShSettings.svelte";
    import TextAreaInput from "../UI/GUI/TextAreaInput.svelte";
    import { ArrowDown, ArrowUp, BookOpenIcon, ChevronRightIcon, HardDriveUploadIcon, PlusIcon, SearchIcon, TrashIcon } from "@lucide/svelte";
    import { selectSingleFile } from "src/ts/util";
    import { doingChat, previewFormated, previewBody, sendChat } from "src/ts/process/index.svelte";
    import SelectInput from "../UI/GUI/SelectInput.svelte";
    import { applyChatTemplate, chatTemplates } from "src/ts/process/templates/chatTemplate";
    import OptionInput from "../UI/GUI/OptionInput.svelte";
    import { loadLoreBookV3Prompt } from "src/ts/process/lorebook.svelte";
    import { risuChatParser } from "src/ts/process/scripts";
    import { getModules } from "src/ts/process/modules";

    let previewMode = $state('chat')
    let previewJoin = $state('yes')
    let instructType = $state('chatml')
    let instructCustom = $state('')

    const preview = async () => {
        if($doingChat){
            return false
        }
        alertWait("Loading...")
        await sendChat(-1, {
            preview: previewJoin !== 'prompt',
            previewPrompt: previewJoin === 'prompt'
        })

        let md = ''
        const styledRole = {
            "function": "📐 Function",
            "user": "😐 User",
            "system": "⚙️ System",
            "assistant": "✨ Assistant",
        }

        if(previewJoin === 'prompt'){
            md += '### Prompt\n'
            md += '```json\n' + JSON.stringify(JSON.parse(previewBody), null, 2).replaceAll('```', '\\`\\`\\`') + '\n```\n'
            $doingChat = false
            alertMd(md)
            return
        }

        let formated = safeStructuredClone(previewFormated)

        if(previewJoin === 'yes'){
            let newFormated = []
            let latestRole = ''

            for(let i=0;i<formated.length;i++){
                if(formated[i].role === latestRole){
                    newFormated[newFormated.length - 1].content += '\n' + formated[i].content
                }else{
                    newFormated.push(formated[i])
                    latestRole = formated[i].role
                }
            }

            formated = newFormated
        }

        if(previewMode === 'instruct'){
            const instructed = applyChatTemplate(formated, {
                type: instructType,
                custom: instructCustom
            })

            md += '### Instruction\n'
            md += '```\n' + instructed.replaceAll('```', '\\`\\`\\`') + '\n```\n'
            $doingChat = false
            alertMd(md)
            return
        }

        for(let i=0;i<formated.length;i++){
            
            md += '### ' + (styledRole[formated[i].role] ?? '🤔 Unknown role') + '\n'
            const modals = formated[i].multimodals

            if(modals && modals.length > 0){
                md += `> ${modals.length} non-text content(s) included\n` 
            }

            if(formated[i].thoughts && formated[i].thoughts.length > 0){
                md += `> ${formated[i].thoughts.length} thought(s) included\n`
            }

            if(formated[i].cachePoint){
                md += `> Cache point\n`
            }

            md += '```\n' + formated[i].content.replaceAll('```', '\\`\\`\\`') + '\n```\n'
        }
        $doingChat = false
        alertMd(md)
    }
    
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
    <ShSettings variant="row">
        <span class="min-w-0 flex-1 truncate">{label}</span>
        <span class="shrink-0 text-textcolor2 tabular-nums">{value}</span>
    </ShSettings>
{/snippet}

<Accordion styled name={language.chatVariables}>
    <ShSettings spacing="divided">
        {#if DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].scriptstate &&  Object.keys(DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].scriptstate).length > 0}
            {#each Object.keys(DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].scriptstate) as key}
                <ShSettings
                    variant="row"
                    size="compact"
                    layout="grid"
                    className="grid-cols-[minmax(0,1fr)_minmax(0,1fr)_1.5rem] gap-1 px-0"
                >
                    <span class="min-w-0 truncate pl-1 text-sm">{key}</span>
                    <div class="min-w-0 flex-1">
                        {#if typeof DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].scriptstate[key] === "object"}
                            <div class="text-center text-sm text-textcolor2">Object</div>
                        {:else if typeof DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].scriptstate[key] === "string"}
                            <TextInput size="sm" className="box-border h-6 min-w-0 max-w-full w-full" bind:value={DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].scriptstate[key] as string} />
                        {:else if typeof DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].scriptstate[key] === "number"}
                            <NumberInput size="sm" className="box-border h-6 min-w-0 max-w-full w-full" bind:value={DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].scriptstate[key] as number} />
                        {/if}
                    </div>
                    <button
                        type="button"
                        class="relative flex size-6 shrink-0 items-center justify-center text-textcolor2 transition-colors after:absolute after:-inset-1 risu-interactive-danger"
                        aria-label={language.remove}
                        title={language.remove}
                        onclick={async () => {
                            if (!await alertConfirm(`${language.removeConfirm}${key}`)) return
                            delete DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].scriptstate[key]
                        }}
                    >
                        <TrashIcon size={16} />
                    </button>
                </ShSettings>
            {/each}
        {:else}
            <div class="p-2 text-center text-textcolor2">No variables</div>
        {/if}
    </ShSettings>
</Accordion>

<Accordion styled name={language.tokens}>
    <ShSettings spacing="divided">
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
    </ShSettings>
    <span class="mt-2 block text-sm text-textcolor2">{language.devToolTokens.estimateNotice}</span>
</Accordion>

<Accordion styled name={language.autopilot}>
    {#if $devToolAutopilotStore.length === 0}
        <span class="text-sm text-textcolor2">{language.noData}</span>
    {/if}
    {#each $devToolAutopilotStore as _, i}
        <div class="mt-2 flex items-center gap-1">
            <div class="min-w-0 flex-1">
                <TextAreaInput highlight bind:value={$devToolAutopilotStore[i]} placeholder="..." fullwidth />
            </div>
            <IconButtonGroup size="sm" direction="vertical">
                <IconButton
                    disabled={i === 0}
                    aria-label="Move up"
                    onclick={() => moveAutopilotItem(i, -1)}
                >
                    <ArrowUp />
                </IconButton>
                <IconButton
                    disabled={i === $devToolAutopilotStore.length - 1}
                    aria-label="Move down"
                    onclick={() => moveAutopilotItem(i, 1)}
                >
                    <ArrowDown />
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
                <HardDriveUploadIcon />
            </IconButton>
        </IconButtonGroup>
        <ShButton
            variant="outline"
            size="sm"
            disabled={$devToolAutopilotStore.length === 0 || $doingChat}
            onclick={runAutopilot}
        >
            {language.run}
        </ShButton>
    </div>
</Accordion>


<Accordion styled name={language.devToolPromptPreview.title}>
    <ShSettings spacing="divided">
        <ShSettings variant="row" className="px-0">
            <span class="min-w-0 pr-2">{language.devToolPromptPreview.type}</span>
            <SelectInput className="min-w-0 flex-1" bind:value={previewMode}>
                <OptionInput value="chat">{language.devToolPromptPreview.chat}</OptionInput>
                <OptionInput value="instruct">{language.devToolPromptPreview.instruct}</OptionInput>
            </SelectInput>
        </ShSettings>
        {#if previewMode === 'instruct'}
            <ShSettings variant="row" className="px-0">
                <span class="min-w-0 pr-2">{language.devToolPromptPreview.instructionType}</span>
                <SelectInput className="min-w-0 flex-1" bind:value={instructType}>
                    {#each Object.keys(chatTemplates) as template}
                        <OptionInput value={template}>{template}</OptionInput>
                    {/each}
                    <OptionInput value="jinja">{language.devToolPromptPreview.customJinja}</OptionInput>
                </SelectInput>
            </ShSettings>
            {#if instructType === 'jinja'}
                <div class="mt-2">
                    <span>{language.devToolPromptPreview.customJinja}</span>
                    <TextAreaInput bind:value={instructCustom} />
                </div>
            {/if}
        {/if}
        <ShSettings variant="row" className="px-0">
            <span class="min-w-0 pr-2">{language.devToolPromptPreview.merge}</span>
            <SelectInput className="min-w-0 flex-1" bind:value={previewJoin}>
                <OptionInput value="yes">{language.devToolPromptPreview.withMerge}</OptionInput>
                <OptionInput value="no">{language.devToolPromptPreview.withoutMerge}</OptionInput>
                <OptionInput value="prompt">{language.devToolPromptPreview.asRequest}</OptionInput>
            </SelectInput>
        </ShSettings>
    </ShSettings>
    <div class="mt-2 flex justify-end">
        <ShButton
            variant="outline"
            size="sm"
            disabled={$doingChat}
            onclick={preview}
        >
            {language.run}
        </ShButton>
    </div>
</Accordion>

<Accordion styled name={language.devToolLorebookPreview.title}>
    <ShSettings spacing="divided">
        <ShSettings variant="row" className="px-0">
            <ShButton
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
                <BookOpenIcon class="text-textcolor2" />
                <span class="min-w-0 flex-1 truncate text-left">{language.devToolLorebookPreview.active}</span>
                <ChevronRightIcon class="text-textcolor2" />
            </ShButton>
        </ShSettings>
        <ShSettings variant="row" className="px-0">
            <ShButton
                variant="ghost"
                className="w-full justify-start px-1"
                onclick={async () => {
                    const lorebookResult = await loadLoreBookV3Prompt()
                    const html = `
                    <table>
                        <thead>
                            <tr>
                                <th>${language.devToolLorebookPreview.keyword}</th>
                                <th>${language.devToolLorebookPreview.source}</th>
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
                <SearchIcon class="text-textcolor2" />
                <span class="min-w-0 flex-1 truncate text-left">{language.devToolLorebookPreview.matches}</span>
                <ChevronRightIcon class="text-textcolor2" />
            </ShButton>
        </ShSettings>
    </ShSettings>
</Accordion>
