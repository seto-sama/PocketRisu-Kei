<script lang="ts">
    import { PlusIcon, XIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { alertConfirm } from "src/ts/alert";
    import type { triggerscript } from "src/ts/storage/database.svelte";
    import Input from "../../UI/components/Input.svelte";
    import Select from "../../UI/components/Select.svelte";
    import SelectOption from "../../UI/components/SelectOption.svelte";
    import NumberInput from "../../UI/components/NumberInput.svelte";
    import Textarea from "../../UI/components/Textarea.svelte";
    import Help from "src/lib/Others/Help.svelte";


    interface Props {
        value: triggerscript;
        lowLevelAble?: boolean;
        onRemove?: () => void;
        onClose?: () => void;
        onOpen?: () => void;
        idx: number;
    }

    let {
        value = $bindable(),
        lowLevelAble = false,
        onRemove = () => {},
        onClose = () => {},
        onOpen = () => {},
        idx
    }: Props = $props();
    let open = $state(false)
</script>

<div class="w-full flex flex-col pt-2 mt-2 border-t border-t-selected first:pt-0 first:mt-0 first:border-0" data-risu-idx2={idx}>
    <div class="flex items-center transition-colors w-full ">
        <button class="endflex valuer border-lightborderc risu-interactive-accent" onclick={() => {
            open = !open
            if(open){
                onOpen()
            }
            else{
                onClose()
            }
        }}>
            <span>{value.comment.length === 0 ? 'Unnamed Trigger' : value.comment}</span>
        </button>
        <button class="valuer risu-interactive-danger" onclick={async () => {
            const d = await alertConfirm(language.removeConfirm + value.comment)
            if(d){
                if(!open){
                    onClose()
                }
                onRemove()
            }
        }}>
            <XIcon />
        </button>
    </div>
    {#if open}
        <div class="seperator p-2">
            <span class="text-maintext mt-6">{language.name}</span>
            <Input size="sm" bind:value={value.comment} />
            <span class="text-maintext mt-4">{language.type}</span>
            <Select bind:value={value.type}>
                <SelectOption value="start">{language.triggerStart}</SelectOption>
                <SelectOption value="output">{language.triggerOutput}</SelectOption>
                <SelectOption value="input">{language.triggerInput}</SelectOption>
                <SelectOption value="manual">{language.triggerManual}</SelectOption>
            </Select>
            
            <span class="text-maintext mt-4">Conditions
                <button aria-labelledby="Add Conditions" class="float-right text-subtext risu-interactive-accent" onclick={() => {
                    value.conditions.push({
                        type: 'value',
                        value: '',
                        operator: 'true',
                        var: ''
                    })
                    value.conditions = value.conditions

                }}><PlusIcon size={18} /></button>
            </span>
            <div class="flex flex-col px-2 py-4 border border-selected rounded-md">
                {#if value.conditions.length === 0}
                    <span class="text-subtext text-sm">{language.always}</span>
                {/if}
                {#each value.conditions as cond,i}
                    {#if i > 0}
                        <hr class="border-selected my-4" />
                    {/if}
                    <span class="text-subtext text-sm">{language.type}
                        <button aria-labelledby="Add Conditions" class="float-right text-subtext risu-interactive-danger" onclick={() => {
                            value.conditions.splice(i, 1)
                            value.conditions = value.conditions
        
                        }}><XIcon size={18} /></button>

                    </span>
                    <Select bind:value={cond.type} size="sm" onchange={() => {
                        if(cond.type === 'exists'){
                            value.conditions[i] = {
                                type: 'exists',
                                value: '',
                                type2: 'loose',
                                depth: 3
                            }
                        }
                        if(cond.type === 'var' || cond.type === 'value'){
                            value.conditions[i] = {
                                type: cond.type,
                                var: '',
                                value: '',
                                operator: '='
                            }
                        }
                        if(cond.type === 'chatindex'){
                            value.conditions[i] = {
                                type: 'chatindex',
                                value: '',
                                operator: '='
                            }
                        }
                    }}>
                        <SelectOption value="value">{language.ifValue}</SelectOption>
                        <SelectOption value="exists">{language.triggerCondExists}</SelectOption>
                        <SelectOption value="var">{language.triggerCondVar}</SelectOption>
                        <SelectOption value="chatindex">{language.ifChatIndex}</SelectOption>
                    </Select>

                    {#if cond.type === 'exists'}
                        <Select bind:value={cond.type2} size="sm">
                            <SelectOption value="loose">{language.triggerMatchLoose}</SelectOption>
                            <SelectOption value="strict">{language.triggerMatchStrict}</SelectOption>
                            <SelectOption value="regex">{language.triggerMatchRegex}</SelectOption>
                        </Select>
                        <span  class="text-subtext text-sm">{language.value}</span>
                        <Textarea bind:value={cond.value} />

                        <span  class="text-subtext text-sm">{language.searchDepth}</span>
                        <NumberInput size="sm" bind:value={cond.depth} />
                    {/if}
                    {#if cond.type === 'var' || cond.type === 'chatindex' || cond.type === 'value'}
                        {#if cond.type === 'var'}
                            <span class="text-subtext text-sm">{language.varableName}</span>
                            <Input size="sm" bind:value={cond.var} />
                        {/if}
                        {#if cond.type === 'value'}
                            <Textarea size="sm" bind:value={cond.var} />
                        {/if}
                        <span  class="text-subtext text-sm">{language.value}</span>
                        <Select bind:value={cond.operator} size="sm">
                            <SelectOption value="true">{language.truthy}</SelectOption>
                            <SelectOption value="=">{language.equal}</SelectOption>
                            <SelectOption value="!=">{language.notEqual}</SelectOption>
                            <SelectOption value=">">{language.greater}</SelectOption>
                            <SelectOption value="<">{language.less}</SelectOption>
                            <SelectOption value=">=">{language.greaterEqual}</SelectOption>
                            <SelectOption value="<=">{language.lessEqual}</SelectOption>
                            <SelectOption value="null">{language.isNull}</SelectOption>

                        </Select>
                        {#if cond.operator !== 'null' && cond.operator !== 'true'}
                            <Textarea size="sm" bind:value={cond.value} />
                        {/if}
                    {/if}
                {/each}
            </div>

            <span class="text-maintext mt-4">Effects
                <button aria-labelledby="Add Effects" class="float-right text-subtext risu-interactive-accent" onclick={() => {
                    if(value.type === 'start'){
                        value.effect.push({
                            type: 'systemprompt',
                            value: '',
                            location: 'historyend'
                        })
                    }
                    else{
                        value.effect.push({
                            type: 'setvar',
                            var: '',
                            value: '',
                            operator: '='
                        })
                    }
                    value.effect = value.effect

                }}><PlusIcon size={18} /></button>
            </span>

            <div class="flex flex-col px-2 py-4 border border-selected rounded-md">
                {#if value.effect.length === 0}
                    <span class="text-subtext text-sm">{language.noEffect}</span>
                {/if}
                {#each value.effect as effect,i}
                    {#if i > 0}
                        <hr class="border-selected my-4" />
                    {/if}
                    <span class="text-subtext text-sm">{language.type}
                        <button aria-labelledby="Add Conditions" class="float-right text-subtext risu-interactive-danger" onclick={() => {
                            value.effect.splice(i, 1)
                            value.effect = value.effect
        
                        }}><XIcon size={18} /></button>

                    </span>
                    <Select bind:value={effect.type} size="sm" onchange={() => {
                        if(effect.type === 'systemprompt'){
                            value.effect[i] = {
                                type: 'systemprompt',
                                value: '',
                                location: 'historyend'
                            }
                        }
                        else if(effect.type === 'setvar'){
                            value.effect[i] = {
                                type: 'setvar',
                                var: '',
                                value: '',
                                operator: '='
                            }
                        }
                        else if(effect.type === 'impersonate'){
                            value.effect[i] = {
                                type: 'impersonate',
                                role: 'char',
                                value: ''
                            }
                        }
                        else if(effect.type === 'command'){
                            value.effect[i] = {
                                type: 'command',
                                value: ''
                            }
                        }
                        else if(effect.type === 'stop'){
                            value.effect[i] = {
                                type: 'stop',
                            }
                        }
                        else if(effect.type === 'runtrigger'){
                            value.effect[i] = {
                                type: 'runtrigger',
                                value: ''
                            }
                        }
                        else if(effect.type === 'runLLM'){
                            value.effect[i] = {
                                type: 'runLLM',
                                value: '',
                                inputVar: ''
                            }
                        }
                        else if(effect.type === 'checkSimilarity'){
                            value.effect[i] = {
                                type: 'checkSimilarity',
                                source: '',
                                value: '',
                                inputVar: ''
                            }
                        }
                        else if(effect.type === 'showAlert'){
                            value.effect[i] = {
                                type: 'showAlert',
                                alertType: 'normal',
                                value: '',
                                inputVar: ''
                            }
                        }
                        else if(effect.type === 'extractRegex'){
                            value.effect[i] ={
                                type: 'extractRegex',
                                value: '',
                                regex: '',
                                flags: '',
                                inputVar: '',
                                result:''
                            }
                        }
                        else if(effect.type === 'runImgGen'){
                            value.effect[i] = {
                                type: 'runImgGen',
                                value: '',
                                negValue: '',
                                inputVar: ''
                            }
                        }
                        else if(effect.type === 'sendAIprompt'){
                            value.effect[i] = {
                                type: 'sendAIprompt'                           
                            }
                        }
                        else if(effect.type === 'cutchat'){
                            value.effect[i] = {
                                type: 'cutchat',
                                start: '',
                                end: ''                           
                            }
                        }
                        else if(effect.type === 'modifychat'){
                            value.effect[i] = {
                                type: 'modifychat',
                                value: '',
                                index: ''
                            }
                        }
                        else if(effect.type === 'runAxLLM'){
                            value.effect[i] = {
                                type: 'runAxLLM',
                                value: '',
                                inputVar: ''
                            }
                        }
                    }}>
                        <SelectOption value="setvar">{language.triggerEffSetVar}</SelectOption>
                        <SelectOption value="impersonate">{language.triggerEffImperson}</SelectOption>
                        <SelectOption value="command">{language.triggerEffCommand}</SelectOption>
                        <SelectOption value="systemprompt">{language.triggerEffSysPrompt}</SelectOption>
                        <SelectOption value="stop">{language.triggerEffStop}</SelectOption>
                        <SelectOption value="runtrigger">{language.triggerEffRunTrigger}</SelectOption>
                        <SelectOption value="runLLM">{language.triggerEffRunLLM}</SelectOption>
                        <SelectOption value="checkSimilarity">{language.triggerEffCheckSim}</SelectOption>
                        <SelectOption value="showAlert">{language.triggerEffShowAlert}</SelectOption>
                        <SelectOption value="sendAIprompt">{language.triggerEffectSendAI}</SelectOption>
                        <SelectOption value="extractRegex">{language.extractRegex}</SelectOption>
                        <SelectOption value="runImgGen">{language.runImgGen}</SelectOption>
                        <SelectOption value="cutchat">{language.cutChat}</SelectOption>
                        <SelectOption value="modifychat">{language.modifyChat}</SelectOption>
                        <SelectOption value="runAxLLM">{language.triggerEffRunAxLLM}</SelectOption>
                    </Select>
                    {#if
                        (value.type !== 'start' && (effect.type === 'systemprompt' || effect.type === 'stop')) ||
                        (value.type !== 'output' && effect.type === 'sendAIprompt')
                    }
                        <span class="text-danger text-sm">{language.invaildTriggerEffect}</span>
                    {/if}
                    {#if
                        !lowLevelAble && (
                            effect.type === 'runLLM' ||
                            effect.type === 'checkSimilarity' ||
                            effect.type === 'showAlert' ||
                            effect.type === 'sendAIprompt' ||
                            effect.type === 'extractRegex' ||
                            effect.type === 'runImgGen' ||
                            effect.type === 'runAxLLM'
                        )
                    }
                        <span class="text-danger text-sm">{language.triggerLowLevelOnly}</span>

                    {/if}

                    {#if effect.type === 'systemprompt'}
                        <span class="text-subtext text-sm">{language.location}</span>
                        <Select bind:value={effect.location}>
                            <SelectOption value="start">{language.promptstart}</SelectOption>
                            <SelectOption value="historyend">{language.historyend}</SelectOption>
                            <SelectOption value="promptend">{language.promptend}</SelectOption>
                        </Select>
                        <span class="text-subtext text-sm">{language.value}</span>
                        <Textarea bind:value={effect.value} />
                    {/if}
                    {#if effect.type === 'setvar'}
                        <span class="text-subtext text-sm">{language.varableName}</span>
                        <Input bind:value={effect.var} />
                        <span class="text-subtext text-sm">{language.operator}</span>
                        <Select bind:value={effect.operator} >
                            <SelectOption value="=">{language.TriggerSetToVar}</SelectOption>
                            <SelectOption value="+=">{language.TriggerAddToVar}</SelectOption>
                            <SelectOption value="-=">{language.TriggerSubToVar}</SelectOption>
                            <SelectOption value="*=">{language.TriggerMulToVar}</SelectOption>
                            <SelectOption value="/=">{language.TriggerDivToVar}</SelectOption>
                        </Select>
                        <span class="text-subtext text-sm">{language.value}</span>
                        <Textarea bind:value={effect.value} />
                    {/if}

                    {#if effect.type === 'runtrigger'}
                        <span class="text-subtext text-sm">{language.name}</span>
                        <Input size="sm" bind:value={effect.value} />
                    {/if}
                    {#if effect.type === 'command'}
                        <span class="text-subtext text-sm">{language.value}</span>
                        <Textarea bind:value={effect.value} />
                    {/if}
                    {#if effect.type === 'runLLM'}
                        <span class="text-subtext text-sm">{language.prompt}<Help key="triggerLLMPrompt" /></span>
                        <Textarea bind:value={effect.value} />

                        <span class="text-subtext text-sm">{language.resultStoredVar}</span>
                        <Input bind:value={effect.inputVar} />
                    {/if}
                    {#if effect.type === 'checkSimilarity'}
                        <span class="text-subtext text-sm">{language.prompt}</span>
                        <Textarea bind:value={effect.source} />

                        <span class="text-subtext text-sm">{language.value}</span>
                        <Textarea bind:value={effect.value} />

                        <span class="text-subtext text-sm">{language.resultStoredVar}</span>
                        <Input bind:value={effect.inputVar} />
                    {/if}
                    {#if effect.type === 'showAlert'}
                        <span class="text-subtext text-sm">{language.type}</span>
                        <Select bind:value={effect.alertType}>
                            <SelectOption value="normal">{language.normal}</SelectOption>
                            <SelectOption value="error">{language.error}</SelectOption>
                            <SelectOption value="input">{language.input}</SelectOption>
                            <SelectOption value="select">{language.select}</SelectOption>
                        </Select>

                        <span class="text-subtext text-sm">{language.value}</span>
                        <Textarea bind:value={effect.value} />

                        <span class="text-subtext text-sm">{language.resultStoredVar}</span>
                        <Input bind:value={effect.inputVar} />
                    {/if}
                    {#if effect.type === 'impersonate'}
                        <span class="text-subtext text-sm">{language.role}</span>
                        <Select bind:value={effect.role} size="sm">
                            <SelectOption value="user">{language.user}</SelectOption>
                            <SelectOption value="char">{language.character}</SelectOption>
                        </Select>
                        <span class="text-subtext text-sm">{language.value}</span>
                        <Textarea bind:value={effect.value} />
                    {/if}

                    {#if effect.type === 'extractRegex'}
                        <span class="text-subtext text-sm">{language.value}</span>
                        <Textarea bind:value={effect.value} />

                        <span class="text-subtext text-sm">{language.regex}</span>
                        <Input bind:value={effect.regex} />

                        <span class="text-subtext text-sm">{language.flags}</span>
                        <Input bind:value={effect.flags} />

                        <span class="text-subtext text-sm">{language.resultFormat}</span>
                        <Input bind:value={effect.result} />

                        <span class="text-subtext text-sm">{language.resultStoredVar}</span>
                        <Input bind:value={effect.inputVar} />
                    {/if}

                    {#if effect.type === 'runImgGen'}
                        <span class="text-subtext text-sm">{language.prompt}</span>
                        <Textarea bind:value={effect.value} />

                        <span class="text-subtext text-sm">{language.negPrompt}</span>
                        <Textarea bind:value={effect.negValue} />

                        <span class="text-subtext text-sm">{language.resultStoredVar}</span>
                        <Input bind:value={effect.inputVar} />
                    {/if}

                    {#if effect.type === 'cutchat'}
                        <span class="text-subtext text-sm">{language.start}</span>
                        <Input bind:value={effect.start} />

                        <span class="text-subtext text-sm">{language.end}</span>
                        <Input bind:value={effect.end} />
                    {/if}

                    {#if effect.type === 'modifychat'}
                        <span class="text-subtext text-sm">{language.index}</span>
                        <Input bind:value={effect.index} />

                        <span class="text-subtext text-sm">{language.value}</span>
                        <Textarea bind:value={effect.value} />
                    
                    {/if}

                    {#if effect.type === 'runAxLLM'}
                    <span class="text-subtext text-sm">{language.prompt}<Help key="triggerLLMPrompt" /></span>
                    <Textarea bind:value={effect.value} />

                    <span class="text-subtext text-sm">{language.resultStoredVar}</span>
                    <Input bind:value={effect.inputVar} />
                    {/if}
                {/each}
            </div>
       </div>
    {/if}
</div>

<style>
    .valuer:is(:hover, :focus-visible){
        cursor: pointer;
    }

    .endflex{
        display: flex;
        flex-grow: 1;
        cursor: pointer;
    }

    .seperator{
        border: none;
        outline: 0;
        width: 100%;
        display: flex;
        flex-direction: column;
        margin-bottom: 0.5rem;
    }
    
</style>
