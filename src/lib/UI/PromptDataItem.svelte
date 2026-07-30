<script lang="ts">
    import type { PromptItem, PromptItemChat, PromptRole } from "src/ts/process/prompt";
    import OptionInput from "./GUI/OptionInput.svelte";
    import TextAreaInput from "./GUI/TextAreaInput.svelte";
    import SelectInput from "./GUI/SelectInput.svelte";
    import { language } from "src/lang";
    import NumberInput from "./GUI/NumberInput.svelte";
    import { TrashIcon } from "@lucide/svelte";
    import TextInput from "./GUI/TextInput.svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import ShDisclosureList from "./GUI/ShDisclosureList.svelte";
    import ShSwitch from "./GUI/ShSwitch.svelte";
    import IconButton from "./GUI/IconButton.svelte";
    import IconButtonGroup from "./GUI/IconButtonGroup.svelte";
    
    interface Props {
        promptItem: PromptItem;
        onRemove?: () => void;
        isOpened?: boolean;
        onToggle?: () => void;
        currentIndex?: number;
    }

    let {
        promptItem = $bindable(),
        onRemove = () => {},
        isOpened = false,
        onToggle = () => {},
        currentIndex = -1,
    }: Props = $props();

    const setAdvancedChat = (advanced: boolean) => {
        const currentprompt = promptItem as PromptItemChat
        if(advanced){
            currentprompt.rangeStart = 0
            currentprompt.rangeEnd = 'end'
        }else{
            currentprompt.rangeStart = -1000
            currentprompt.rangeEnd = 'end'
        }
        promptItem = currentprompt
    }

    const hasPromptBlockRole = (promptItem: PromptItem): promptItem is PromptItem & { role?: PromptRole } => {
        return promptItem.type === 'persona' || promptItem.type === 'description' || promptItem.type === 'authornote' || promptItem.type === 'memory' || promptItem.type === 'lorebook'
    }

    const isPromptRole = (role: unknown): role is PromptRole => {
        return role === 'user' || role === 'bot' || role === 'system'
    }

    function getName(promptItem:PromptItem){

        if(promptItem.name){
            return promptItem.name
        }

        if(promptItem.type === 'plain'){
            return language.formating.plain
        }
        if(promptItem.type === 'jailbreak'){
            return language.formating.jailbreak
        }
        if(promptItem.type === 'chat'){
            return language.Chat
        }
        if(promptItem.type === 'persona'){
            return language.formating.personaPrompt
        }
        if(promptItem.type === 'description'){
            return language.formating.description
        }
        if(promptItem.type === 'authornote'){
            return language.formating.authorNote
        }
        if(promptItem.type === 'lorebook'){
            return language.formating.lorebook
        }
        if(promptItem.type === 'memory'){
            return language.formating.memory
        }
        if(promptItem.type === 'postEverything'){
            return language.formating.postEverything
        }
        if(promptItem.type === 'cot'){
            return language.cot
        }
        if(promptItem.type === 'chatML'){
            return 'ChatML'
        }
        return ""
    }

    function replacePrompt(prompt:PromptItem){
        if(JSON.stringify(promptItem) === JSON.stringify(prompt)){
            return
        }

        const ind = DBState.db.promptTemplate.findIndex((item, index) => {
            return JSON.stringify(item) === JSON.stringify(prompt)
        })

        if(ind !== -1){
            DBState.db.promptTemplate.splice(ind, 1)
        }
        const myInd = DBState.db.promptTemplate.findIndex((item, index) => {
            return JSON.stringify(item) === JSON.stringify(promptItem)
        })
        DBState.db.promptTemplate.splice(myInd, 0, prompt)

    }

</script>

<ShDisclosureList className="mb-2" data-risu-idx={currentIndex} data-disclosure-drag-name={getName(promptItem)}>
<ShDisclosureList
    variant="item"
    open={isOpened}
    isLast
    dividerTone="muted"
    {onToggle}
>
    {#snippet header()}
        <span>{getName(promptItem)}</span>
    {/snippet}
    {#snippet actions()}
        <IconButtonGroup size="default">
            <IconButton tone="destructive" data-disclosure-action="delete" aria-label={language.remove} onclick={onRemove}><TrashIcon /></IconButton>
        </IconButtonGroup>
    {/snippet}

    <div data-disclosure-field>
        <div data-disclosure-label>{language.name}</div>
        <div data-disclosure-control><TextInput bind:value={promptItem.name} /></div>
    </div>

    <div data-disclosure-field>
        <div data-disclosure-label>{language.type}</div>
        <div data-disclosure-control>
            <SelectInput bind:value={promptItem.type} onchange={() => {
                if(promptItem.type === 'plain' || promptItem.type === 'jailbreak' || promptItem.type === 'cot'){
                    promptItem.text = ""
                    promptItem.role = "system"
                }
                if(promptItem.type === 'cache'){
                    promptItem.depth = 1
                    promptItem.role = 'all'
                }
                if(promptItem.type === 'chat'){
                    promptItem.rangeStart = -1000
                    promptItem.rangeEnd = 'end'
                }
                if(hasPromptBlockRole(promptItem) && !isPromptRole(promptItem.role)){
                    promptItem.role = 'system'
                }
            }}>
                <OptionInput value="plain">{language.formating.plain}</OptionInput>
                <OptionInput value="jailbreak">{language.formating.jailbreak}</OptionInput>
                <OptionInput value="chat">{language.Chat}</OptionInput>
                <OptionInput value="persona">{language.formating.personaPrompt}</OptionInput>
                <OptionInput value="description">{language.formating.description}</OptionInput>
                <OptionInput value="authornote">{language.formating.authorNote}</OptionInput>
                <OptionInput value="lorebook">{language.formating.lorebook}</OptionInput>
                <OptionInput value="memory">{language.formating.memory}</OptionInput>
                <OptionInput value="postEverything">{language.formating.postEverything}</OptionInput>
                <OptionInput value="chatML">chatML</OptionInput>
                <OptionInput value="cache">{language.cachePoint}</OptionInput>

                {#if DBState.db.promptSettings.customChainOfThought}
                    <OptionInput value="cot">{language.cot}</OptionInput>
                {/if}
            </SelectInput>
        </div>
    </div>

    {#if promptItem.type === 'plain' || promptItem.type === 'jailbreak' || promptItem.type === 'cot'}
        <div data-disclosure-field>
            <div data-disclosure-label>{language.specialType}</div>
            <div data-disclosure-control>
                <SelectInput bind:value={promptItem.type2}>
                    <OptionInput value="normal">{language.noSpecialType}</OptionInput>
                    <OptionInput value="main">{language.mainPrompt}</OptionInput>
                    <OptionInput value="globalNote">{language.globalNote}</OptionInput>
                </SelectInput>
            </div>
        </div>
    {/if}

    {#if promptItem.type === 'cache'}
        <div data-disclosure-field>
            <div data-disclosure-label>{language.depth}</div>
            <div data-disclosure-control><NumberInput bind:value={promptItem.depth} /></div>
        </div>
    {/if}

    {#if promptItem.type === 'plain' || promptItem.type === 'jailbreak' || promptItem.type === 'cot'}
        <div data-disclosure-field>
            <div data-disclosure-label>{language.role}</div>
            <div data-disclosure-control>
                <SelectInput bind:value={promptItem.role}>
                    <OptionInput value="user">{language.user}</OptionInput>
                    <OptionInput value="assistant">{language.character}</OptionInput>
                    <OptionInput value="system">{language.systemPrompt}</OptionInput>
                </SelectInput>
            </div>
        </div>
    {:else if promptItem.type === 'cache'}
        <div data-disclosure-field>
            <div data-disclosure-label>{language.role}</div>
            <div data-disclosure-control>
                <SelectInput bind:value={promptItem.role}>
                    <OptionInput value="all">{language.all}</OptionInput>
                    <OptionInput value="user">{language.user}</OptionInput>
                    <OptionInput value="bot">{language.character}</OptionInput>
                    <OptionInput value="system">{language.systemPrompt}</OptionInput>
                </SelectInput>
            </div>
        </div>
    {:else if hasPromptBlockRole(promptItem)}
        <div data-disclosure-field>
            <div data-disclosure-label>{language.role}</div>
            <div data-disclosure-control>
                <SelectInput value={promptItem.role ?? 'system'} onchange={(event) => {
                    if(hasPromptBlockRole(promptItem)){
                        promptItem.role = event.currentTarget.value as PromptRole
                    }
                }}>
                    <OptionInput value="user">{language.user}</OptionInput>
                    <OptionInput value="bot">{language.character}</OptionInput>
                    <OptionInput value="system">{language.systemPrompt}</OptionInput>
                </SelectInput>
            </div>
        </div>
    {/if}

    {#if promptItem.type === 'plain' || promptItem.type === 'jailbreak' || promptItem.type === 'cot'}
        <div data-disclosure-field>
            <div data-disclosure-label>{language.prompt}</div>
            <div data-disclosure-control><TextAreaInput highlight bind:value={promptItem.text} /></div>
        </div>
    {:else if promptItem.type === 'chatML'}
        <div data-disclosure-field>
            <div data-disclosure-label>{language.prompt}</div>
            <div data-disclosure-control><TextAreaInput highlight bind:value={promptItem.text} /></div>
        </div>
    {/if}

    {#if promptItem.type === 'chat'}
        {#if promptItem.rangeStart !== -1000}
            <div data-disclosure-field>
                <div data-disclosure-label>{language.rangeStart}</div>
                <div data-disclosure-control><NumberInput bind:value={promptItem.rangeStart} /></div>
            </div>
            <div data-disclosure-field>
                <div data-disclosure-label>{language.rangeEnd}</div>
                <div data-disclosure-control>
                    {#if promptItem.rangeEnd === 'end'}
                        <NumberInput value={0} disabled />
                    {:else}
                        <NumberInput bind:value={promptItem.rangeEnd} />
                    {/if}
                </div>
            </div>
            <div data-disclosure-row>
                <span class="text-sm text-textcolor">{language.untilChatEnd}</span>
                <ShSwitch checked={promptItem.rangeEnd === 'end'} onCheckedChange={(checked) => {
                    if(promptItem.type === 'chat'){
                        promptItem.rangeEnd = checked ? 'end' : 0
                    }
                }} />
            </div>
            {#if DBState.db.promptSettings.sendChatAsSystem}
                <div data-disclosure-row>
                    <span class="text-sm text-textcolor">{language.chatAsOriginalOnSystem}</span>
                    <ShSwitch checked={!!promptItem.chatAsOriginalOnSystem} onCheckedChange={(checked) => {
                        if(promptItem.type === 'chat'){
                            promptItem.chatAsOriginalOnSystem = checked
                        }
                    }} />
                </div>
            {/if}
        {/if}
        <div data-disclosure-row>
            <span class="text-sm text-textcolor">{language.advanced}</span>
            <ShSwitch checked={promptItem.rangeStart !== -1000} onCheckedChange={setAdvancedChat} />
        </div>
    {/if}

    {#if promptItem.type === 'authornote'}
        <div data-disclosure-field>
            <div data-disclosure-label>{language.defaultPrompt}</div>
            <div data-disclosure-control><TextInput bind:value={promptItem.defaultText} /></div>
        </div>
    {/if}

    {#if promptItem.type === 'persona' || promptItem.type === 'description' || promptItem.type === 'authornote' || promptItem.type === 'memory'}
        {#if promptItem.innerFormat}
            <div data-disclosure-field>
                <div data-disclosure-label>{language.innerFormat}</div>
                <div data-disclosure-control><TextAreaInput highlight bind:value={promptItem.innerFormat}/></div>
            </div>
        {/if}
        <div data-disclosure-row>
            <span class="text-sm text-textcolor">{language.customInnerFormat}</span>
            <ShSwitch checked={!!promptItem.innerFormat} onCheckedChange={(checked) => {
                if(promptItem.type === 'persona' || promptItem.type === 'description' || promptItem.type === 'authornote' || promptItem.type === 'memory'){
                    promptItem.innerFormat = checked ? (promptItem.innerFormat || "{{slot}}") : undefined
                }
            }} />
        </div>
    {/if}
</ShDisclosureList>
</ShDisclosureList>
