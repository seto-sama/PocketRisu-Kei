<script lang="ts">
    import type { PromptItem, PromptItemCache, PromptItemChat, PromptItemPlain, PromptRole } from "src/ts/process/prompt";
    import SelectOption from "./components/SelectOption.svelte";
    import Textarea from "./components/Textarea.svelte";
    import Select from "./components/Select.svelte";
    import { language } from "src/lang";
    import { promptRoleLabel, promptType2Label, promptTypeLabel } from "src/ts/process/promptLabels";
    import NumberInput from "./components/NumberInput.svelte";
    import { TrashIcon } from "@lucide/svelte";
    import Input from "./components/Input.svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import DisclosureList from "./components/DisclosureList.svelte";
    import Switch from "./components/Switch.svelte";
    import IconButton from "./components/IconButton.svelte";
    import IconButtonGroup from "./components/IconButtonGroup.svelte";
    
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

    const promptTypes: PromptItem['type'][] = ['plain', 'jailbreak', 'chat', 'persona', 'description', 'authornote', 'lorebook', 'memory', 'postEverything', 'chatML', 'cache']
    const promptType2s: PromptItemPlain['type2'][] = ['normal', 'main', 'globalNote']
    const promptRoles: PromptRole[] = ['user', 'bot', 'system']
    const cacheRoles: PromptItemCache['role'][] = ['all', 'user', 'assistant', 'system']

    function getName(promptItem:PromptItem){
        return promptItem.name || promptTypeLabel(promptItem.type)
    }

</script>

<DisclosureList className="mb-2" data-risu-idx={currentIndex} data-disclosure-drag-name={getName(promptItem)}>
<DisclosureList
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
        <div data-disclosure-control><Input bind:value={promptItem.name} /></div>
    </div>

    <div data-disclosure-field>
        <div data-disclosure-label>{language.type}</div>
        <div data-disclosure-control>
            <Select bind:value={promptItem.type} onchange={() => {
                if(promptItem.type === 'plain' || promptItem.type === 'jailbreak'){
                    promptItem.text = ""
                    promptItem.role = "system"
                }
                if(promptItem.type === 'chatML'){
                    promptItem.text = ""
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
                {#each promptTypes as type}
                    <SelectOption value={type}>{promptTypeLabel(type)}</SelectOption>
                {/each}
            </Select>
        </div>
    </div>

    {#if promptItem.type === 'plain' || promptItem.type === 'jailbreak'}
        <div data-disclosure-field>
            <div data-disclosure-label>{language.specialType}</div>
            <div data-disclosure-control>
                <Select bind:value={promptItem.type2}>
                    {#each promptType2s as type2}
                        <SelectOption value={type2}>{promptType2Label(type2) ?? language.noSpecialType}</SelectOption>
                    {/each}
                </Select>
            </div>
        </div>
    {/if}

    {#if promptItem.type === 'cache'}
        <div data-disclosure-field>
            <div data-disclosure-label>{language.depth}</div>
            <div data-disclosure-control><NumberInput bind:value={promptItem.depth} /></div>
        </div>
    {/if}

    {#if promptItem.type === 'plain' || promptItem.type === 'jailbreak'}
        <div data-disclosure-field>
            <div data-disclosure-label>{language.role}</div>
            <div data-disclosure-control>
                <Select bind:value={promptItem.role}>
                    {#each promptRoles as role}
                        <SelectOption value={role}>{promptRoleLabel(role)}</SelectOption>
                    {/each}
                </Select>
            </div>
        </div>
    {:else if promptItem.type === 'cache'}
        <div data-disclosure-field>
            <div data-disclosure-label>{language.role}</div>
            <div data-disclosure-control>
                <Select bind:value={promptItem.role}>
                    {#each cacheRoles as role}
                        <SelectOption value={role}>{promptRoleLabel(role)}</SelectOption>
                    {/each}
                </Select>
            </div>
        </div>
    {:else if hasPromptBlockRole(promptItem)}
        <div data-disclosure-field>
            <div data-disclosure-label>{language.role}</div>
            <div data-disclosure-control>
                <Select value={promptItem.role ?? 'system'} onchange={(event) => {
                    if(hasPromptBlockRole(promptItem)){
                        promptItem.role = event.currentTarget.value as PromptRole
                    }
                }}>
                    {#each promptRoles as role}
                        <SelectOption value={role}>{promptRoleLabel(role)}</SelectOption>
                    {/each}
                </Select>
            </div>
        </div>
    {/if}

    {#if promptItem.type === 'plain' || promptItem.type === 'jailbreak' || promptItem.type === 'chatML'}
        <div data-disclosure-field>
            <div data-disclosure-label>{language.prompt}</div>
            <div data-disclosure-control><Textarea bind:value={promptItem.text} popupTitle={getName(promptItem)} /></div>
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
                <span class="text-sm text-maintext">{language.untilChatEnd}</span>
                <Switch checked={promptItem.rangeEnd === 'end'} onCheckedChange={(checked) => {
                    if(promptItem.type === 'chat'){
                        promptItem.rangeEnd = checked ? 'end' : 0
                    }
                }} />
            </div>
            {#if DBState.db.promptSettings.sendChatAsSystem}
                <div data-disclosure-row>
                    <span class="text-sm text-maintext">{language.chatAsOriginalOnSystem}</span>
                    <Switch checked={!!promptItem.chatAsOriginalOnSystem} onCheckedChange={(checked) => {
                        if(promptItem.type === 'chat'){
                            promptItem.chatAsOriginalOnSystem = checked
                        }
                    }} />
                </div>
            {/if}
        {/if}
        <div data-disclosure-row>
            <span class="text-sm text-maintext">{language.advanced}</span>
            <Switch checked={promptItem.rangeStart !== -1000} onCheckedChange={setAdvancedChat} />
        </div>
    {/if}

    {#if promptItem.type === 'authornote'}
        <div data-disclosure-field>
            <div data-disclosure-label>{language.defaultPrompt}</div>
            <div data-disclosure-control><Input bind:value={promptItem.defaultText} /></div>
        </div>
    {/if}

    {#if promptItem.type === 'persona' || promptItem.type === 'description' || promptItem.type === 'authornote' || promptItem.type === 'memory'}
        {#if promptItem.innerFormat}
            <div data-disclosure-field>
                <div data-disclosure-label>{language.innerFormat}</div>
                <div data-disclosure-control><Textarea bind:value={promptItem.innerFormat} popupTitle={getName(promptItem)}/></div>
            </div>
        {/if}
        <div data-disclosure-row>
            <span class="text-sm text-maintext">{language.customInnerFormat}</span>
            <Switch checked={!!promptItem.innerFormat} onCheckedChange={(checked) => {
                if(promptItem.type === 'persona' || promptItem.type === 'description' || promptItem.type === 'authornote' || promptItem.type === 'memory'){
                    promptItem.innerFormat = checked ? (promptItem.innerFormat || "{{slot}}") : undefined
                }
            }} />
        </div>
    {/if}
</DisclosureList>
</DisclosureList>
