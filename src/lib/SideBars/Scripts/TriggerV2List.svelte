<script lang="ts">
    import { PlusIcon, DownloadIcon, UploadIcon, TrashIcon, XIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import { type triggerEffectV2, type triggerEffect, type triggerscript, displayAllowList, requestAllowList } from "src/ts/process/triggers";
    import { onDestroy, onMount } from "svelte";
    import { DBState } from "src/ts/stores.svelte";
    import IconButton from "src/lib/UI/GUI/IconButton.svelte";
    import IconButtonGroup from "src/lib/UI/GUI/IconButtonGroup.svelte";
    import ShDisclosureList from "src/lib/UI/GUI/ShDisclosureList.svelte";
    import Sortable from "sortablejs";
    import { sleep, sortableOptions } from "src/ts/util";
    import { alertConfirm } from "src/ts/alert";
    import TriggerV2EffectData from "./TriggerV2EffectData.svelte";
    import { createTriggerV2Effect, effectCategories } from "./triggerV2EffectRegistry";
    import {
        appendTriggerV2Effect,
        getTriggerV2ElseBlock,
        moveTriggerV2Effect,
        removeTriggerV2Effect,
        toggleTriggerV2Else,
    } from "./triggerV2EffectTree";

    interface Props {
        value?: triggerscript[];
        lowLevelAble?: boolean;
    }

    let { value = $bindable([]), lowLevelAble = false }: Props = $props();
    let selectedIndex = $state(0)
    let selectedCategory = $state('Control')
    let triggerListElement = $state<HTMLDivElement | null>(null)
    let triggerListSortable: Sortable | null = null
    let triggerListKey = $state(0)
    let openedTriggers = $state(new Set<triggerscript>())
    let openedEffects = $state(new Set<triggerEffect>())
    let addingEffectForIndex = $state(-1)

    $effect(() => {
        if (!value || value.length === 0) {
            value = [{
                comment: '',
                type: 'start',
                conditions: [],
                effect: [],
            }]
        }
        if (selectedIndex >= value.length) selectedIndex = Math.max(0, value.length - 1)
        if (selectedIndex < 0) selectedIndex = 0
    })

    const getFilteredTriggers = () => {
        const allCategories = DBState.db.showDeprecatedTriggerV2 
            ? effectCategories
            : Object.fromEntries(Object.entries(effectCategories).filter(([key]) => key !== 'Deprecated'))
        
        const categoryTriggers = allCategories[selectedCategory] || []
        return categoryTriggers.filter(checkSupported)
    }

    const getAvailableCategories = () => {
        const allCategories = DBState.db.showDeprecatedTriggerV2 
            ? effectCategories
            : Object.fromEntries(Object.entries(effectCategories).filter(([key]) => key !== 'Deprecated'))
        
        return Object.keys(allCategories).filter(category => {
            const categoryTriggers = allCategories[category] || []
            return categoryTriggers.some(checkSupported)
        })
    }

    $effect(() => {
        const availableCategories = getAvailableCategories()
        if (availableCategories.length > 0 && !availableCategories.includes(selectedCategory)) {
            selectedCategory = availableCategories[0]
        }
    })

    const toggleTrigger = (index: number) => {
        const trigger = value?.[index]
        if (!trigger || index === 0) return
        if (openedTriggers.has(trigger)) {
            openedTriggers.delete(trigger)
            if (addingEffectForIndex === index) addingEffectForIndex = -1
        } else {
            openedTriggers.add(trigger)
            selectedIndex = index
        }
        openedTriggers = new Set(openedTriggers)
    }

    const addTrigger = () => {
        value = [...value, {
            comment: "",
            type: "manual",
            conditions: [],
            effect: []
        }]
        const trigger = value.at(-1)
        if (trigger) {
            openedTriggers.add(trigger)
            openedTriggers = new Set(openedTriggers)
            selectedIndex = value.length - 1
        }
    }

    const removeTriggerAt = async (index: number) => {
        const trigger = value?.[index]
        if (!trigger || index === 0 || value.length <= 2) return
        const confirmed = await alertConfirm(language.removeConfirm + (trigger.comment || 'Unnamed Trigger'))
        if (!confirmed) return
        openedTriggers.delete(trigger)
        for (const effect of trigger.effect) openedEffects.delete(effect)
        openedTriggers = new Set(openedTriggers)
        openedEffects = new Set(openedEffects)
        value = value.filter((_, triggerIndex) => triggerIndex !== index)
        if (selectedIndex === index) selectedIndex = 0
    }

    const getTriggerTypeLabel = (type: triggerscript['type']) => {
        switch (type) {
            case 'start': return language.triggerStart
            case 'output': return language.triggerOutput
            case 'input': return language.triggerInput
            case 'manual': return language.triggerManual
            case 'display': return language.editDisplay
            case 'request': return language.editProcess
            default: return type
        }
    }

    const renameTrigger = (index: number, comment: string) => {
        const trigger = value[index]
        if (!trigger) return
        const previousComment = trigger.comment
        for (const candidate of value.slice(1)) {
            for (const effect of candidate.effect) {
                if (effect.type === 'v2RunTrigger' && effect.target === previousComment) effect.target = comment
            }
        }
        trigger.comment = comment
    }

    const createTriggerListSortable = () => {
        if (!triggerListElement || triggerListSortable || openedTriggers.size > 0) return
        triggerListSortable = Sortable.create(triggerListElement, {
            onEnd: async () => {
                const indexes = Array.from(triggerListElement?.querySelectorAll('[data-trigger-v2-index]') ?? [])
                    .map((element) => Number(element.getAttribute('data-trigger-v2-index')))
                value = [value[0], ...indexes.map((index) => value[index]).filter(Boolean)]
                try {
                    triggerListSortable?.destroy()
                } catch (error) {}
                triggerListSortable = null
                triggerListKey += 1
                await sleep(1)
                createTriggerListSortable()
            },
            ...sortableOptions,
            handle: '[data-disclosure-toggle]',
            animation: 150,
            chosenClass: 'risu-chosen-item',
            dragClass: 'risu-drag-item',
            ghostClass: 'risu-ghost-item',
        })
    }

    const toggleEffect = (triggerIndex: number, effect: triggerEffect) => {
        selectedIndex = triggerIndex
        if (openedEffects.has(effect)) {
            openedEffects.delete(effect)
        } else {
            const defaultEffect = createTriggerV2Effect(effect.type)
            if (defaultEffect) {
                for (const [field, defaultValue] of Object.entries(defaultEffect)) {
                    if (!(field in effect)) effect[field] = safeStructuredClone(defaultValue)
                }
            }
            openedEffects.add(effect)
        }
        openedEffects = new Set(openedEffects)
    }

    const removeEffectAt = (triggerIndex: number, effectIndex: number) => {
        const effect = value[triggerIndex]?.effect[effectIndex]
        if (!effect) return
        value[triggerIndex].effect = removeTriggerV2Effect(value[triggerIndex].effect, effectIndex)
        openedEffects.delete(effect)
        openedEffects = new Set(openedEffects)
        value = [...value]
    }

    const getElseBlock = (triggerIndex: number, effectIndex: number) => {
        return getTriggerV2ElseBlock(value[triggerIndex]?.effect ?? [], effectIndex)
    }

    const toggleElseBlock = (triggerIndex: number, effectIndex: number, checked: boolean) => {
        const trigger = value[triggerIndex]
        if (!trigger) return
        trigger.effect = toggleTriggerV2Else(trigger.effect, effectIndex, checked)
        value = [...value]
    }

    const addEffect = (triggerIndex: number, type: string) => {
        const trigger = value[triggerIndex]
        if (!trigger) return
        selectedIndex = triggerIndex
        const newEffect = createTriggerV2Effect(type)
        if (!newEffect) return
        const lastEffect = trigger.effect.at(-1) as triggerEffectV2 | undefined
        newEffect.indent = lastEffect?.type === 'v2EndIndent'
            ? Math.max(0, lastEffect.indent - 1)
            : (lastEffect?.indent ?? 0)
        trigger.effect = appendTriggerV2Effect(trigger.effect, newEffect)
        openedEffects.add(newEffect)
        openedEffects = new Set(openedEffects)
        addingEffectForIndex = -1
        value = [...value]
    }

    $effect(() => {
        if (openedTriggers.size > 0 && triggerListSortable) {
            try {
                triggerListSortable.destroy()
            } catch (error) {}
            triggerListSortable = null
        } else if (openedTriggers.size === 0 && triggerListElement && !triggerListSortable) {
            createTriggerListSortable()
        }
    })

    const importTriggers = () => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.json'
        input.onchange = async (event) => {
            const file = (event.target as HTMLInputElement)?.files?.[0]
            if (!file) return
            
            try {
                const text = await file.text()
                const importedTriggers = JSON.parse(text)
                
                if (!Array.isArray(importedTriggers)) {
                    return
                }
                
                for (const trigger of importedTriggers) {
                    if (!trigger.hasOwnProperty('comment') || 
                        !trigger.hasOwnProperty('type') ||
                        !trigger.hasOwnProperty('conditions') ||
                        !trigger.hasOwnProperty('effect') ||
                        !Array.isArray(trigger.conditions) ||
                        !Array.isArray(trigger.effect)) {
                        return
                    }
                }
                
                for (const trigger of importedTriggers) {
                    value.push(trigger)
                }
                
            } catch (error) {
                console.error('Import error:', error)
            }
        }
        
        input.click()
    }

    const checkSupported = (e:string, triggerIndex = selectedIndex) => {
        if(!value || value.length === 0 || triggerIndex < 0 || triggerIndex >= value.length || !value[triggerIndex]){
            return false
        }
        if(value[triggerIndex].type === 'display'){
            return displayAllowList.includes(e)
        }
        if(value[triggerIndex].type === 'request'){
            return requestAllowList.includes(e)
        }
        if(effectCategories['Special'].includes(e)){
            return false
        }

        if(lowLevelAble){
            return true
        }
        return !effectCategories['Low Level'].includes(e)
    }


    const formatEffectDisplay = (effect:triggerEffect, triggerIndex = selectedIndex) => {
        const type = effect.type

        if(!checkSupported(type, triggerIndex)){
            return `<span class="text-red-500">${language.triggerDesc.v2UnsupportedTriggerDesc}</span>`
        }

        const txt = (language.triggerDesc[type + 'Desc'] as string || type).replace(/{{(.+?)}}/g, (match, p1) => {
            const d = effect[p1]
            
            if(type === 'v2Comment' && p1 === 'value') {
                return `<span class="text-gray-400">${d || ''}</span>`
            }
            
            if(typeof d === 'boolean'){
                return `<span class="text-blue-500">${d ? 'true' : 'false'}</span>`
            }
            
            if(p1.endsWith('Type')){
                return `<span class="text-blue-500">${d || 'null' }</span>`
            }
            if(p1 === 'condition' || p1 === 'operator'){
                return `<span class="text-green-500">${d || 'null'}</span>`
            }
            if(effect[p1 + 'Type'] === 'var'){
                return `<span class="text-yellow-500">${d || 'null'}</span>`
            }
            if(effect[p1 + 'Type'] === 'value'){
                return `<span class="text-green-500">"${d}"</span>`
            }
            if(effect.type === 'v2If' && p1 === 'source'){
                return `<span class="text-yellow-500">${d || 'null'}</span>`
            }
            if(effect.type === 'v2SetVar' && p1 === 'var'){
                return `<span class="text-yellow-500">${d || 'null'}</span>`
            }
            if(effect.type === 'v2DeclareLocalVar' && p1 === 'var'){
                return `<span class="text-cyan-500">${d || 'null'}</span>`
            }
            return `<span class="text-blue-500">${d || 'null'}</span>`
        })

        if(type === 'v2Comment') {
            return `<div class="text-gray-500 italic line-clamp-4" style="margin-left:${(effect as triggerEffectV2).indent}rem; word-break: break-all; overflow-wrap: break-word;">// ${txt}</div>`
        }

        return `<div class="text-purple-500 line-clamp-4" style="margin-left:${(effect as triggerEffectV2).indent}rem; word-break: break-all; overflow-wrap: break-word;">${txt}</div>`
    }
    
    onMount(createTriggerListSortable)

    onDestroy(() => {
        if (triggerListSortable) {
            try {
                triggerListSortable.destroy()
            } catch (error) {}
        }
    })
</script>

{#key triggerListKey}
    <ShDisclosureList className="mt-2" bind:element={triggerListElement}>
        {#if value.length <= 1}
            <div class="px-3 py-8 text-center text-sm text-textcolor2">No Scripts</div>
        {/if}
        {#each value as trigger, i}
            {#if i > 0}
                <ShDisclosureList
                    variant="item"
                    open={openedTriggers.has(trigger)}
                    onToggle={() => toggleTrigger(i)}
                    data-disclosure-drag-name={trigger.comment || 'Unnamed Trigger'}
                    data-trigger-v2-index={i}
                >
                    {#snippet header()}
                        <div class="flex min-w-0 flex-1 items-center gap-2">
                            <span class="min-w-0 flex-1 truncate">{trigger.comment || 'Unnamed Trigger'}</span>
                            <span class="hidden shrink-0 text-xs text-textcolor2 sm:inline">
                                {getTriggerTypeLabel(trigger.type)}
                            </span>
                        </div>
                    {/snippet}
                    {#snippet actions()}
                        <IconButton
                            className="no-sort"
                            tone="destructive"
                            data-disclosure-action="delete"
                            aria-label={language.remove}
                            disabled={value.length <= 2}
                            onclick={(event) => {
                                event.stopPropagation()
                                removeTriggerAt(i)
                            }}
                        >
                            <TrashIcon />
                        </IconButton>
                    {/snippet}

                    <div data-disclosure-field>
                        <div data-disclosure-label>{language.name}</div>
                        <div data-disclosure-control>
                            <TextInput
                                value={trigger.comment}
                                oninput={(event) => renameTrigger(i, event.currentTarget.value)}
                            />
                        </div>
                    </div>

                    <div data-disclosure-field>
                        <div data-disclosure-label>{language.triggerOn}</div>
                        <div data-disclosure-control>
                            <SelectInput bind:value={trigger.type}>
                                <OptionInput value="start">{language.triggerStart}</OptionInput>
                                <OptionInput value="output">{language.triggerOutput}</OptionInput>
                                <OptionInput value="input">{language.triggerInput}</OptionInput>
                                <OptionInput value="manual">{language.triggerManual}</OptionInput>
                                <OptionInput value="display">{language.editDisplay}</OptionInput>
                                <OptionInput value="request">{language.editProcess}</OptionInput>
                            </SelectInput>
                        </div>
                    </div>

                    <div class="mt-2 mb-2 flex items-center justify-between">
                        <span class="text-sm text-textcolor">{language.action} {language.list}</span>
                        <IconButton aria-label={language.add} onclick={(event) => {
                            event.stopPropagation()
                            selectedIndex = i
                            addingEffectForIndex = addingEffectForIndex === i ? -1 : i
                        }}>
                            {#if addingEffectForIndex === i}<XIcon />{:else}<PlusIcon />{/if}
                        </IconButton>
                    </div>

                    {#if addingEffectForIndex === i}
                        <div class="mb-2 rounded-md border border-darkborderc bg-darkbg p-2">
                            <div data-disclosure-field>
                                <div data-disclosure-label>{language.type}</div>
                                <div data-disclosure-control>
                                    <SelectInput bind:value={selectedCategory}>
                                        {#each getAvailableCategories() as category}
                                            <OptionInput value={category}>{language.triggerCategories[category] || category}</OptionInput>
                                        {/each}
                                    </SelectInput>
                                </div>
                            </div>
                            <div class="max-h-64 overflow-y-auto rounded-md border border-darkborderc">
                                {#each getFilteredTriggers() as type}
                                    <button
                                        type="button"
                                        class="block w-full border-b border-darkborderc p-2 text-left text-sm text-textcolor2 last:border-b-0 hover:bg-selected hover:text-textcolor"
                                        class:opacity-60={effectCategories.Deprecated.includes(type)}
                                        onclick={() => addEffect(i, type)}
                                    >
                                        {language.triggerDesc[type]}
                                        {#if effectCategories.Deprecated.includes(type)}
                                            <span class="ml-1 text-xs opacity-60">(Deprecated)</span>
                                        {/if}
                                    </button>
                                {/each}
                            </div>
                            <CheckInput bind:check={DBState.db.showDeprecatedTriggerV2} name={language.showDeprecatedTriggerV2} grayText className="mt-2" />
                        </div>
                    {/if}

                    <ShDisclosureList background={false} className="border-darkborderc p-2">
                        {#if trigger.effect.length === 0}
                            <div class="px-3 py-6 text-center text-sm text-textcolor2">{language.noEffect}</div>
                        {/if}
                        {#each trigger.effect as effect, effectIndex}
                            <div
                                role="listitem"
                                draggable={!openedEffects.has(effect) && effect.type !== 'v2EndIndent' && effect.type !== 'v2Else'}
                                class:cursor-grab={!openedEffects.has(effect) && effect.type !== 'v2EndIndent' && effect.type !== 'v2Else'}
                                ondragstart={(event) => {
                                    event.dataTransfer?.setData('text/plain', 'trigger-v2-effect')
                                    event.dataTransfer?.setData('effectIndex', effectIndex.toString())
                                }}
                                ondragover={(event) => event.preventDefault()}
                                ondrop={(event) => {
                                    event.preventDefault()
                                    if (event.dataTransfer?.getData('text/plain') !== 'trigger-v2-effect') return
                                    selectedIndex = i
                                    const fromIndex = Number(event.dataTransfer?.getData('effectIndex'))
                                    value[i].effect = moveTriggerV2Effect(value[i].effect, fromIndex, effectIndex)
                                    value = [...value]
                                }}
                            >
                                <TriggerV2EffectData
                                    value={effect as triggerEffectV2}
                                    open={openedEffects.has(effect)}
                                    removable={effect.type !== 'v2EndIndent'}
                                    showElse={effect.type === 'v2If' || effect.type === 'v2IfAdvanced'}
                                    hasElse={(getElseBlock(i, effectIndex)?.elseIndex ?? -1) !== -1}
                                    triggerNames={value.slice(1).map((candidate) => candidate.comment)}
                                    titleHtml={effect.type === 'v2EndIndent'
                                        ? `<span class="text-textcolor2" style="margin-left:${(effect as triggerEffectV2).indent}rem">...</span>`
                                        : formatEffectDisplay(effect, i)}
                                    onToggle={() => {
                                        if (effect.type !== 'v2EndIndent') toggleEffect(i, effect)
                                    }}
                                    onRemove={() => removeEffectAt(i, effectIndex)}
                                    onElseChange={(checked) => toggleElseBlock(i, effectIndex, checked)}
                                />
                            </div>
                        {/each}
                    </ShDisclosureList>
                </ShDisclosureList>
            {/if}
        {/each}
    </ShDisclosureList>
{/key}

<IconButtonGroup className="mt-2">
    <IconButton aria-label={language.add} onclick={addTrigger}>
        <PlusIcon />
    </IconButton>
    <IconButton aria-label="Export triggers" onclick={() => {
        const jsonData = JSON.stringify(value.slice(1), null, 2)
        const blob = new Blob([jsonData], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = `triggers-${new Date().getTime()}.json`
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        URL.revokeObjectURL(url)
    }}>
        <DownloadIcon />
    </IconButton>
    <IconButton aria-label="Import triggers" onclick={importTriggers}>
        <UploadIcon />
    </IconButton>
</IconButtonGroup>
