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

    interface Props {
        value?: triggerscript[];
        lowLevelAble?: boolean;
    }

    const effectCategories = {
        'Special': [
            'v2GetDisplayState',
            'v2SetDisplayState',
            'v2GetRequestState',
            'v2SetRequestState',
            'v2GetRequestStateRole',
            'v2SetRequestStateRole',
            'v2GetRequestStateLength'
        ],
        'Control': [
            'v2SetVar',
            'v2DeclareLocalVar',
            'v2Calculate',
            'v2IfAdvanced',
            'v2LoopNTimes',
            'v2Loop',
            'v2BreakLoop',
            'v2Command',
            'v2ConsoleLog',
            'v2RunTrigger',
            'v2StopTrigger',
            'v2Comment'
        ],
        'Chat': [
            'v2CutChat',
            'v2ModifyChat',
            'v2Impersonate',
            'v2GetLastMessage',
            'v2GetLastUserMessage',
            'v2GetLastCharMessage',
            'v2GetMessageAtIndex',
            'v2GetMessageCount',
            'v2GetFirstMessage',
            'v2QuickSearchChat'
        ],
        'Low Level': [
            'v2SendAIprompt',
            'v2ImgGen',
            'v2CheckSimilarity',
            'v2RunLLM'
        ],
        'Alert': [
            'v2ShowAlert',
            'v2GetAlertInput',
            'v2GetAlertSelect'
        ],
        'Lorebook V2': [
            'v2GetAllLorebooks',
            'v2GetLorebookByName',
            'v2GetLorebookByIndex',
            'v2CreateLorebook',
            'v2ModifyLorebookByIndex',
            'v2DeleteLorebookByIndex',
            'v2GetLorebookCountNew',
            'v2SetLorebookAlwaysActive'
        ],
        'String': [
            'v2RegexTest',
            'v2ExtractRegex',
            'v2GetCharAt',
            'v2GetCharCount',
            'v2ToLowerCase',
            'v2ToUpperCase',
            'v2SetCharAt',
            'v2SplitString',
            'v2ConcatString',
            'v2ReplaceString'
        ],
        'Data': [
            'v2GetCharacterDesc',
            'v2SetCharacterDesc',
            'v2GetPersonaDesc',
            'v2SetPersonaDesc',
            'v2GetReplaceGlobalNote',
            'v2SetReplaceGlobalNote',
            'v2GetAuthorNote',
            'v2SetAuthorNote'
        ],
        'Array': [
            'v2MakeArrayVar',
            'v2GetArrayVarLength',
            'v2GetArrayVar',
            'v2SetArrayVar',
            'v2PushArrayVar',
            'v2PopArrayVar',
            'v2ShiftArrayVar',
            'v2UnshiftArrayVar',
            'v2SpliceArrayVar',
            'v2SliceArrayVar',
            'v2GetIndexOfValueInArrayVar',
            'v2RemoveIndexFromArrayVar',
            'v2JoinArrayVar'
        ],
        'Dictionary': [
            'v2MakeDictVar',
            'v2GetDictVar',
            'v2SetDictVar',
            'v2DeleteDictKey',
            'v2HasDictKey',
            'v2ClearDict',
            'v2GetDictSize',
            'v2GetDictKeys',
            'v2GetDictValues'
        ],
        'Others': [
            'v2Random',
            'v2UpdateGUI',
            'v2SystemPrompt',
            'v2UpdateChatAt',
            'v2Wait',
            'v2StopPromptSending',
            'v2Tokenize'
        ],
        'Deprecated': [
            'v2If',
            'v2ModifyLorebook',
            'v2GetLorebook',
            'v2GetLorebookCount',
            'v2GetLorebookEntry',
            'v2SetLorebookActivation',
            'v2GetLorebookIndexViaName'
        ]
    }

    let lastClickTime = 0
    let { value = $bindable([]), lowLevelAble = false }: Props = $props();
    let selectedIndex = $state(0);
    let selectedEffectIndex = $state(-1);
    let selectedTriggerIndices = $state<number[]>([]);
    let lastSelectedTriggerIndex = $state(-1);
    let menuMode = $state(0)
    let isDragging = $state(false);
    let dragOverIndex = $state(-1);
    let isEffectDragging = $state(false);
    let effectDragOverIndex = $state(-1);
    let editTrigger:triggerEffectV2 = $state(null as triggerEffectV2)
    let addElse = $state(false)
    let selectMode = $state(0) //0 = trigger 1 = effect
    let contextMenu = $state(false)
    let contextMenuLoc = $state({x: 0, y: 0, style: ''})
    let selectedTriggerIndex = $state(0)
    let selectedEffectIndexSaved = $state(-1)
    let effectElements = $state<HTMLButtonElement[]>([])
    let guideLineKey = $state(0)
    let selectedCategory = $state('Control')
    let isMobileScreen = $state(false)
    let previousMenuMode = $state(0)    
    let menu0Container = $state<HTMLDivElement | null>(null)
    let triggerScrollRef = $state<HTMLDivElement | null>(null)
    let triggerListElement = $state<HTMLDivElement | null>(null)
    let triggerListSortable: Sortable | null = null
    let triggerListKey = $state(0)
    let openedTriggers = $state(new Set<triggerscript>())
    let openedEffects = $state(new Set<triggerEffect>())
    let addingEffectForIndex = $state(-1)
    
    let isRestoringMode = $state(false)
    let previousSelectedTriggerIndex = $state(-1)
    
    const scrollManager = $state({
        mode0ScrollPosition: { menu0: 0, trigger: 0 },
        otherModeScrollPositions: new Map([
            [1, { menu0: 0, trigger: 0 }],
            [2, { menu0: 0, trigger: 0 }],
            [3, { menu0: 0, trigger: 0 }]
        ]),
        autoScrollInterval: null as number | null,
        scrollSpeed: 8,
        scrollThreshold: 50,
        
        saveMode0ScrollPositions() {
            try {
                if (menu0Container) {
                    this.mode0ScrollPosition.menu0 = menu0Container.scrollTop
                }
                if (triggerScrollRef && typeof triggerScrollRef.scrollTop === 'number') {
                    this.mode0ScrollPosition.trigger = triggerScrollRef.scrollTop
                }
            } catch (e) {
                console.warn('Failed to save mode0 scroll positions:', e)
            }
        },
        
        restoreMode0ScrollPositions() {
            try {
                setTimeout(() => {
                    if (menu0Container) {
                        menu0Container.scrollTop = this.mode0ScrollPosition.menu0
                    }
                    if (triggerScrollRef && triggerScrollRef.scrollTop !== null && triggerScrollRef.scrollTop !== undefined) {
                        triggerScrollRef.scrollTop = this.mode0ScrollPosition.trigger
                    }
                }, 10)
            } catch (e) {
                console.warn('Failed to restore mode0 scroll positions:', e)
            }
        },
        
        saveOtherModeScrollPositions(mode: number) {
            try {
                if (mode === 0) return
                
                const positions = this.otherModeScrollPositions.get(mode) || { menu0: 0, trigger: 0 }
                if (menu0Container) {
                    positions.menu0 = menu0Container.scrollTop
                }
                if (triggerScrollRef && typeof triggerScrollRef.scrollTop === 'number') {
                    positions.trigger = triggerScrollRef.scrollTop
                }
                this.otherModeScrollPositions.set(mode, positions)
            } catch (e) {
                console.warn('Failed to save other mode scroll positions:', e)
            }
        },
        
        restoreOtherModeScrollPositions(mode: number) {
            try {
                if (mode === 0) return
                
                const positions = this.otherModeScrollPositions.get(mode) || { menu0: 0, trigger: 0 }
                setTimeout(() => {
                    if (menu0Container) {
                        menu0Container.scrollTop = positions.menu0
                    }
                    if (triggerScrollRef && triggerScrollRef.scrollTop !== null && triggerScrollRef.scrollTop !== undefined) {
                        triggerScrollRef.scrollTop = positions.trigger
                    }
                }, 10)
            } catch (e) {
                console.warn('Failed to restore other mode scroll positions:', e)
            }
        },
        
        resetEffectScrollInMode0() {
            try {
                if (menu0Container) {
                    menu0Container.scrollTop = 0
                    this.mode0ScrollPosition.menu0 = 0
                }
            } catch (e) {
                console.warn('Failed to reset effect scroll in mode0:', e)
            }
        },
        
        handleTriggerScroll() {
            try {
                if (triggerScrollRef && typeof triggerScrollRef.scrollTop === 'number') {
                    if (menuMode === 0) {
                        this.mode0ScrollPosition.trigger = triggerScrollRef.scrollTop
                    } else {
                        const positions = this.otherModeScrollPositions.get(menuMode) || { menu0: 0, trigger: 0 }
                        positions.trigger = triggerScrollRef.scrollTop
                        this.otherModeScrollPositions.set(menuMode, positions)
                    }
                }
            } catch (e) {
                console.warn('Failed to handle trigger scroll:', e)
            }
        },
        
        handleMenu0Scroll() {
            try {
                if (menu0Container && typeof menu0Container.scrollTop === 'number') {
                    if (menuMode === 0) {
                        this.mode0ScrollPosition.menu0 = menu0Container.scrollTop
                    } else {
                        const positions = this.otherModeScrollPositions.get(menuMode) || { menu0: 0, trigger: 0 }
                        positions.menu0 = menu0Container.scrollTop
                        this.otherModeScrollPositions.set(menuMode, positions)
                    }
                }
            } catch (e) {
                console.warn('Failed to handle menu0 scroll:', e)
            }
        },
        
        stopAutoScroll() {
            if (this.autoScrollInterval !== null) {
                window.clearInterval(this.autoScrollInterval)
                this.autoScrollInterval = null
            }
        },
        
        startAutoScroll(container: HTMLElement, direction: 'up' | 'down', speed?: number) {
            this.stopAutoScroll()
            const scrollSpeed = speed || this.scrollSpeed
            
            this.autoScrollInterval = window.setInterval(() => {
                if (!container) return
                
                const scrollAmount = direction === 'up' ? -scrollSpeed : scrollSpeed
                container.scrollBy(0, scrollAmount)
                
                if ((direction === 'up' && container.scrollTop <= 0) || 
                    (direction === 'down' && container.scrollTop >= container.scrollHeight - container.clientHeight)) {
                    this.stopAutoScroll()
                }
            }, 16)
        },
        
        checkAutoScrollZone(mouseY: number, containerRect: DOMRect): 'up' | 'down' | null {
            const topZone = containerRect.top + this.scrollThreshold
            const bottomZone = containerRect.bottom - this.scrollThreshold
            
            if (mouseY < topZone) {
                return 'up'
            } else if (mouseY > bottomZone) {
                return 'down'
            }
            
            return null
        }
    })


    type VirtualClipboard = {
        type: 'trigger',
        value: triggerscript[]
    }|{
        type: 'effect',
        value: triggerEffect[]
    }
    let clipboard:VirtualClipboard = $state(null)

    $effect(() => {
        if (!value || value.length === 0) {
            value = [{
                comment: '',
                type: 'start',
                conditions: [],
                effect: []
            }];
        }
    });


    $effect(() => {
        if (value && value.length > 0) {
            if (selectedIndex >= value.length) {
                selectedIndex = Math.max(0, value.length - 1)
                selectedTriggerIndex = selectedIndex
            } else if (selectedIndex < 0) {
                selectedIndex = 0
                selectedTriggerIndex = 0
            }
        }
    })
    
    $effect(() => {
        if(previousMenuMode !== menuMode) {
            if(previousMenuMode === 0 && menuMode !== 0) {
                scrollManager.saveMode0ScrollPositions()
            }
            else if(previousMenuMode !== 0) {
                scrollManager.saveOtherModeScrollPositions(previousMenuMode)
            }
            
            if(menuMode === 0 && previousMenuMode !== 0){
                addElse = false
                isRestoringMode = true
                scrollManager.restoreMode0ScrollPositions()
                
                if(selectedTriggerIndex > 0) {
                    setTimeout(() => {
                        try {
                            if(value && value.length > selectedTriggerIndex) {
                                selectedIndex = selectedTriggerIndex
                                if(selectedEffectIndexSaved >= 0 && value[selectedTriggerIndex]?.effect && selectedEffectIndexSaved < value[selectedTriggerIndex].effect.length) {
                                    selectedEffectIndex = selectedEffectIndexSaved
                                }
                            } else if(value && value.length > 1) {
                                selectedIndex = 1
                                selectedTriggerIndex = 1
                            } else {
                                selectedIndex = 0
                                selectedTriggerIndex = 0
                            }
                        } catch(e) {
                            console.warn('Failed to restore trigger selection:', e)
                        }
                        setTimeout(() => {
                            isRestoringMode = false
                        }, 10)
                    }, 15)
                } else {
                    setTimeout(() => {
                        isRestoringMode = false
                    }, 25)
                }
            }
            else if(menuMode !== 0) {
                scrollManager.restoreOtherModeScrollPositions(menuMode)
                if(previousMenuMode === 0) {
                    clearTriggerSelection()
                }
            }
            
            if (menuMode === 0) {
                previousSelectedTriggerIndex = selectedTriggerIndex
            }
            
            previousMenuMode = menuMode
        }
    })

    $effect(() => {
        if (menuMode === 0 && selectedIndex !== selectedTriggerIndex && selectedIndex >= 0 && value && value.length > selectedIndex) {
            selectedTriggerIndex = selectedIndex
            selectedEffectIndex = -1
        }
    })

    $effect(() => {
        if (menuMode === 0 && selectedTriggerIndex >= 0 && !isRestoringMode && previousSelectedTriggerIndex !== selectedTriggerIndex) {
            scrollManager.resetEffectScrollInMode0()
            previousSelectedTriggerIndex = selectedTriggerIndex
        }
    })

    $effect(() => {
        if(menuMode === 0 && selectedIndex >= 0 && value && value.length > selectedIndex) {
            setTimeout(() => updateGuideLines(), 10)
            setTimeout(() => updateGuideLines(), 50)
        }
    })

    $effect(() => {
        if(selectedIndex >= 0 && value && value[selectedIndex]?.effect) {
            value[selectedIndex].effect.length
            if(menuMode === 0) {
                setTimeout(() => updateGuideLines(), 10)
                setTimeout(() => updateGuideLines(), 100)
            }
        }
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

    const close = () => {
        selectedIndex = 0;
        selectedTriggerIndex = 0;
        selectedEffectIndexSaved = -1;
    }

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
        if (selectedIndex === index) close()
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
            makeDefaultEditType(effect.type)
            if (editTrigger?.type === effect.type) {
                for (const [field, defaultValue] of Object.entries(editTrigger)) {
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
        selectedIndex = triggerIndex
        selectedEffectIndex = effectIndex
        deleteEffect()
        openedEffects.delete(effect)
        openedEffects = new Set(openedEffects)
        value = [...value]
    }

    const getElseBlock = (triggerIndex: number, effectIndex: number) => {
        const effects = value[triggerIndex]?.effect ?? []
        const effect = effects[effectIndex] as triggerEffectV2 | undefined
        if (!effect || (effect.type !== 'v2If' && effect.type !== 'v2IfAdvanced')) return null
        const endIndentIndex = effects.findIndex((candidate, index) =>
            index > effectIndex && candidate.type === 'v2EndIndent' && (candidate as triggerEffectV2).indent === effect.indent + 1)
        if (endIndentIndex === -1) return { endIndentIndex, elseIndex: -1, elseEndIndex: -1 }
        const elseIndex = effects[endIndentIndex + 1]?.type === 'v2Else' && (effects[endIndentIndex + 1] as triggerEffectV2).indent === effect.indent
            ? endIndentIndex + 1
            : -1
        const elseEndIndex = elseIndex === -1
            ? -1
            : effects.findIndex((candidate, index) =>
                index > elseIndex && candidate.type === 'v2EndIndent' && (candidate as triggerEffectV2).indent === effect.indent + 1)
        return { endIndentIndex, elseIndex, elseEndIndex }
    }

    const toggleElseBlock = (triggerIndex: number, effectIndex: number, checked: boolean) => {
        const trigger = value[triggerIndex]
        const effect = trigger?.effect[effectIndex] as triggerEffectV2 | undefined
        const block = getElseBlock(triggerIndex, effectIndex)
        if (!trigger || !effect || !block) return
        if (checked && block.elseIndex === -1 && block.endIndentIndex !== -1) {
            trigger.effect.splice(block.endIndentIndex + 1, 0,
                { type: 'v2Else', indent: effect.indent },
                { type: 'v2EndIndent', indent: effect.indent + 1 })
        } else if (!checked && block.elseIndex !== -1 && block.elseEndIndex !== -1) {
            trigger.effect.splice(block.elseIndex, block.elseEndIndex - block.elseIndex + 1)
        }
        value = [...value]
    }

    const addEffect = (triggerIndex: number, type: string) => {
        const trigger = value[triggerIndex]
        if (!trigger) return
        selectedIndex = triggerIndex
        makeDefaultEditType(type)
        const newEffect = safeStructuredClone(editTrigger) as triggerEffectV2
        const lastEffect = trigger.effect.at(-1) as triggerEffectV2 | undefined
        newEffect.indent = lastEffect?.type === 'v2EndIndent'
            ? Math.max(0, lastEffect.indent - 1)
            : (lastEffect?.indent ?? 0)
        trigger.effect.push(newEffect)
        if (newEffect.type === 'v2If' || newEffect.type === 'v2IfAdvanced' || newEffect.type === 'v2Loop' || newEffect.type === 'v2LoopNTimes' || newEffect.type === 'v2Else') {
            trigger.effect.push({
                type: 'v2EndIndent',
                indent: newEffect.indent + 1,
                endOfLoop: newEffect.type === 'v2Loop' || newEffect.type === 'v2LoopNTimes'
            })
        }
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

    const isMultipleSelected = () => {
        return selectedTriggerIndices.length > 0
    }

    const isTriggerSelected = (index: number) => {
        return selectedTriggerIndices.includes(index)
    }

    const clearTriggerSelection = () => {
        selectedTriggerIndices = []
        lastSelectedTriggerIndex = -1
    }

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

    const selectTriggerRange = (startIndex: number, endIndex: number) => {
        const start = Math.min(startIndex, endIndex)
        const end = Math.max(startIndex, endIndex)
        const range = []
        for (let i = start; i <= end; i++) {
            if (i > 0) {
                range.push(i)
            }
        }
        selectedTriggerIndices = range
    }

    const handleTriggerClick = (index: number, event: MouseEvent) => {
        event.preventDefault()
        event.stopPropagation()
        
        if (event.shiftKey && lastSelectedTriggerIndex !== -1) {
            selectTriggerRange(lastSelectedTriggerIndex, index)
        } else {
            selectedTriggerIndices = [index]
            lastSelectedTriggerIndex = index
            selectedIndex = index
            selectedTriggerIndex = index
        }
        selectMode = 0
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
    const makeDefaultEditType = (type:string) => {
        editTrigger = null as triggerEffectV2
        switch(type){
            case 'v2SetVar':
                editTrigger = {
                    type: 'v2SetVar',
                    operator: '=',
                    var: '',
                    value: '',
                    valueType: 'value',
                    indent: 0
                }
                break;
            case 'v2If':
                editTrigger = {
                    type: 'v2If',
                    indent: 0,
                    condition: '=',
                    targetType: 'value',
                    target: '',
                    source: ''
                }
                break;
            case 'v2IfAdvanced':
                editTrigger = {
                    type: 'v2IfAdvanced',
                    indent: 0,
                    condition: '=',
                    targetType: 'value',
                    target: '',
                    sourceType: 'value',
                    source: '',
                }
                break;
            case 'v2Else':
                editTrigger = {
                    type: 'v2Else',
                    indent: 0
                }
                break;
            case 'v2Loop':
                editTrigger = {
                    type: 'v2Loop',
                    indent: 0,
                }
                break;
            case 'v2LoopNTimes':
                editTrigger = {
                    type: 'v2LoopNTimes',
                    indent: 0,
                    value: '',
                    valueType: 'value'
                }
                break;
            case 'v2BreakLoop':
                editTrigger = {
                    type: 'v2BreakLoop',
                    indent: 0
                }
                break;
            case 'v2RunTrigger':
                editTrigger = {
                    type: 'v2RunTrigger',
                    indent: 0,
                    target: ''
                }
                break;
            case 'v2ConsoleLog':
                editTrigger = {
                    type: 'v2ConsoleLog',
                    indent: 0,
                    sourceType: 'value',
                    source: ''
                }
                break;
            case 'v2StopTrigger':
                editTrigger = {
                    type: 'v2StopTrigger',
                    indent: 0
                }
                break;
            case 'v2CutChat':
                editTrigger = {
                    type: 'v2CutChat',
                    indent: 0,
                    start: '0',
                    end: '0',
                    startType: 'value',
                    endType: 'value'
                }
                break;
            case 'v2ModifyChat':
                editTrigger = {
                    type: 'v2ModifyChat',
                    index: '',
                    indexType: 'value',
                    value: '',
                    valueType: 'value',
                    indent: 0
                }
                break;
            case 'v2SystemPrompt':
                editTrigger = {
                    type: 'v2SystemPrompt',
                    location: 'start',
                    value: '',
                    valueType: 'value',
                    indent: 0
                }
                break;
            case 'v2Impersonate':
                editTrigger = {
                    type: 'v2Impersonate',
                    role: 'user',
                    value: '',
                    valueType: 'value',
                    indent: 0
                }
                break;
            case 'v2Command':
                editTrigger = {
                    type: 'v2Command',
                    value: '',
                    valueType: 'value',
                    indent: 0
                }
                break;
            case 'v2SendAIprompt':
                editTrigger = {
                    type: 'v2SendAIprompt',
                    indent: 0
                }
                break;
            case 'v2ImgGen':
                editTrigger = {
                    type: 'v2ImgGen',
                    value: '',
                    valueType: 'value',
                    negValue: '',
                    negValueType: 'value',
                    outputVar: '',
                    indent: 0
                }
                break;
            case 'v2CheckSimilarity':
                editTrigger = {
                    type: 'v2CheckSimilarity',
                    source: '',
                    sourceType: 'value',
                    value: '',
                    valueType: 'value',
                    outputVar: '',
                    indent: 0
                }
                break;
            case 'v2RunLLM':
                editTrigger = {
                    type: 'v2RunLLM',
                    value: '',
                    valueType: 'value',
                    outputVar: '',
                    indent: 0,
                    model: 'model',
                    streaming: false
                }
                break;
            case 'v2ShowAlert':
                editTrigger = {
                    type: 'v2ShowAlert',
                    value: '',
                    valueType: 'value',
                    indent: 0
                }
                break;
            case 'v2ExtractRegex':
                editTrigger = {
                    type: 'v2ExtractRegex',
                    value: '',
                    valueType: 'value',
                    regex: '',
                    regexType: 'value',
                    flags: '',
                    flagsType: 'value',
                    result: '',
                    resultType: 'value',
                    outputVar: '',
                    indent: 0
                }
                break;
            case 'v2GetLastMessage':
                editTrigger = {
                    type: 'v2GetLastMessage',
                    outputVar: '',
                    indent: 0
                }
                break;
            case 'v2GetMessageAtIndex':
                editTrigger = {
                    type: 'v2GetMessageAtIndex',
                    index: '',
                    indexType: 'value',
                    outputVar: '',
                    indent: 0
                }
                break;
            case 'v2GetMessageCount':
                editTrigger = {
                    type: 'v2GetMessageCount',
                    outputVar: '',
                    indent: 0
                }
                break;
            case 'v2ModifyLorebook':
                editTrigger = {
                    type: 'v2ModifyLorebook',
                    target: '',
                    targetType: 'value',
                    value: '',
                    valueType: 'value',
                    indent: 0
                }
                break;
            case 'v2GetLorebook':
                editTrigger = {
                    type: 'v2GetLorebook',
                    target: '',
                    targetType: 'value',
                    outputVar: '',
                    indent: 0
                }
                break;
            case 'v2GetLorebookCount':
                editTrigger = {
                    type: 'v2GetLorebookCount',
                    outputVar: '',
                    indent: 0
                }
                break;
            case 'v2GetLorebookEntry':
                editTrigger = {
                    type: 'v2GetLorebookEntry',
                    index: '',
                    indexType: 'value',
                    outputVar: '',
                    indent: 0
                }
                break;
            case 'v2SetLorebookActivation':
                editTrigger = {
                    type: 'v2SetLorebookActivation',
                    index: '',
                    indexType: 'value',
                    value: true,
                    indent: 0
                }
                break;
            case 'v2GetLorebookIndexViaName':
                editTrigger = {
                    type: 'v2GetLorebookIndexViaName',
                    name: '',
                    nameType: 'value',
                    outputVar: '',
                    indent: 0
                }
                break;
            case 'v2Random':
                editTrigger = {
                    type: 'v2Random',
                    outputVar: '',
                    min: '0',
                    max: '100',
                    minType: 'value',
                    maxType: 'value',
                    indent: 0
                }
                break;
            case 'v2GetCharAt':
                editTrigger = {
                    type: 'v2GetCharAt',
                    source: '',
                    sourceType: 'value',
                    index: '',
                    indexType: 'value',
                    outputVar: '',
                    indent: 0
                }
                break;
            case 'v2GetCharCount':
                editTrigger = {
                    type: 'v2GetCharCount',
                    source: '',
                    sourceType: 'value',
                    outputVar: '',
                    indent: 0
                }
                break;
            case 'v2ToLowerCase':
                editTrigger = {
                    type: 'v2ToLowerCase',
                    source: '',
                    sourceType: 'value',
                    outputVar: '',
                    indent: 0
                }
                break;
            case 'v2ToUpperCase':
                editTrigger = {
                    type: 'v2ToUpperCase',
                    source: '',
                    sourceType: 'value',
                    outputVar: '',
                    indent: 0
                }
                break;
            case 'v2SetCharAt':
                editTrigger = {
                    type: 'v2SetCharAt',
                    source: '',
                    sourceType: 'value',
                    index: '',
                    indexType: 'value',
                    value: '',
                    valueType: 'value',
                    outputVar: '',
                    indent: 0
                }
                break;
            case 'v2SplitString':
                editTrigger = {
                    type: 'v2SplitString',
                    source: '',
                    sourceType: 'value',
                    delimiter: '',
                    delimiterType: 'value',
                    outputVar: '',
                    indent: 0
                }
                break;
            case 'v2JoinArrayVar':
                editTrigger = {
                    type: 'v2JoinArrayVar',
                    var: '',
                    varType: 'value',
                    delimiter: '',
                    delimiterType: 'value',
                    outputVar: '',
                    indent: 0
                }
                break;
            case 'v2GetCharacterDesc':
                editTrigger = {
                    type: 'v2GetCharacterDesc',
                    outputVar: '',
                    indent: 0
                }
                break;
            case 'v2SetCharacterDesc':
                editTrigger = {
                    type: 'v2SetCharacterDesc',
                    value: '',
                    valueType: 'value',
                    indent: 0
                }
                break;
            case 'v2GetPersonaDesc':
                editTrigger = {
                    type: 'v2GetPersonaDesc',
                    outputVar: '',
                    indent: 0
                }
                break;
            case 'v2SetPersonaDesc':
                editTrigger = {
                    type: 'v2SetPersonaDesc',
                    value: '',
                    valueType: 'value',
                    indent: 0
                }
                break;
            case 'v2MakeArrayVar':
                editTrigger = {
                    type: 'v2MakeArrayVar',
                    var: '',
                    indent: 0
                }
                break;
            case 'v2GetArrayVarLength':
                editTrigger = {
                    type: 'v2GetArrayVarLength',
                    var: '',
                    outputVar: '',
                    indent: 0
                }
                break;
            case 'v2GetArrayVar':
                editTrigger = {
                    type: 'v2GetArrayVar',
                    var: '',
                    index: '',
                    indexType: 'value',
                    outputVar: '',
                    indent: 0
                }
                break;
            case 'v2SetArrayVar':
                editTrigger = {
                    type: 'v2SetArrayVar',
                    var: '',
                    index: '',
                    indexType: 'value',
                    value: '',
                    valueType: 'value',
                    indent: 0
                }
                break;
            case 'v2Tokenize':{
                editTrigger = {
                    type: 'v2Tokenize',
                    value: '',
                    valueType: 'value',
                    indent: 0,
                    outputVar: ""
                }
                break;
            }
            case 'v2PushArrayVar':
                editTrigger = {
                    type: 'v2PushArrayVar',
                    var: '',
                    value: '',
                    valueType: 'value',
                    indent: 0
                }
                break;
            case 'v2PopArrayVar':
                editTrigger = {
                    type: 'v2PopArrayVar',
                    var: '',
                    outputVar: '',
                    indent: 0
                }
                break;
            case 'v2ShiftArrayVar':
                editTrigger = {
                    type: 'v2ShiftArrayVar',
                    var: '',
                    outputVar: '',
                    indent: 0
                }
                break;
            case 'v2UnshiftArrayVar':
                editTrigger = {
                    type: 'v2UnshiftArrayVar',
                    var: '',
                    value: '',
                    valueType: 'value',
                    indent: 0
                }
                break;
            case 'v2SpliceArrayVar':
                editTrigger = {
                    type: 'v2SpliceArrayVar',
                    var: '',
                    start: '',
                    startType: 'value',
                    item: '',
                    itemType: 'value',
                    indent: 0
                }
                break;
            case 'v2SliceArrayVar':
                editTrigger = {
                    type: 'v2SliceArrayVar',
                    var: '',
                    start: '',
                    startType: 'value',
                    end: '',
                    endType: 'value',
                    outputVar: '',
                    indent: 0
                }
                break;
            case 'v2GetIndexOfValueInArrayVar':
                editTrigger = {
                    type: 'v2GetIndexOfValueInArrayVar',
                    var: '',
                    value: '',
                    valueType: 'value',
                    outputVar: '',
                    indent: 0
                }
                break;
            case 'v2RemoveIndexFromArrayVar':
                editTrigger = {
                    type: 'v2RemoveIndexFromArrayVar',
                    var: '',
                    index: '',
                    indexType: 'value',
                    indent: 0
                }
                break;
            case 'v2ConcatString':
                editTrigger = {
                    type: 'v2ConcatString',
                    source1: '',
                    source1Type: 'value',
                    source2: '',
                    source2Type: 'value',
                    outputVar: '',
                    indent: 0
                }
                break;
            case 'v2GetLastUserMessage':{
                editTrigger = {
                    type: 'v2GetLastUserMessage',
                    outputVar: '',
                    indent: 0
                }
                break;
            }
            case 'v2GetLastCharMessage':{
                editTrigger = {
                    type: 'v2GetLastCharMessage',
                    outputVar: '',
                    indent: 0
                }
                break;
            }
            case 'v2GetFirstMessage':{
                editTrigger = {
                    type: 'v2GetFirstMessage',
                    outputVar: '',
                    indent: 0
                }
                break;
            }
            case 'v2GetAlertInput':{
                editTrigger = {
                    type: 'v2GetAlertInput',
                    outputVar: '',
                    indent: 0,
                    display: '',
                    displayType: 'value'
                }
                break;
            }
            case 'v2GetAlertSelect':{
                editTrigger = {
                    type: 'v2GetAlertSelect',
                    display: '',
                    displayType: 'value',
                    value: '',
                    valueType: 'value',
                    outputVar: '',
                    indent: 0
                }
                break;
            }
            case 'v2GetDisplayState':{
                editTrigger = {
                    type: 'v2GetDisplayState',
                    outputVar: '',
                    indent: 0
                }
                break;
            }
            case 'v2SetDisplayState':{
                editTrigger = {
                    type: 'v2SetDisplayState',
                    value: '',
                    valueType: 'value',
                    indent: 0
                }
                break;
            }
            case 'v2UpdateGUI':{
                editTrigger = {
                    type: 'v2UpdateGUI',
                    indent: 0
                }
                break;
            }
            case 'v2UpdateChatAt':{
                editTrigger = {
                    type: 'v2UpdateChatAt',
                    index: '0',
                    indent: 0
                }
                break;
            }
            case 'v2Wait':{
                editTrigger = {
                    type: 'v2Wait',
                    value: '1',
                    valueType: 'value',
                    indent: 0
                }
                break;
            }
            case 'v2GetRequestState':{
                editTrigger = {
                    type: 'v2GetRequestState',
                    outputVar: '',
                    index: '',
                    indexType: 'value',
                    indent: 0
                }
                break;
            }
            case 'v2SetRequestState':{
                editTrigger = {
                    type: 'v2SetRequestState',
                    value: '',
                    valueType: 'value',
                    index: '',
                    indexType: 'value',
                    indent: 0
                }
                break;
            }
            case 'v2GetRequestStateRole':{
                editTrigger = {
                    type: 'v2GetRequestStateRole',
                    outputVar: '',
                    index: '',
                    indexType: 'value',
                    indent: 0
                }
                break;
            }
            case 'v2SetRequestStateRole':{
                editTrigger = {
                    type: 'v2SetRequestStateRole',
                    value: '',
                    valueType: 'value',
                    index: '',
                    indexType: 'value',
                    indent: 0
                }
                break;
            }
            case 'v2GetRequestStateLength':{
                editTrigger = {
                    type: 'v2GetRequestStateLength',
                    outputVar: '',
                    indent: 0
                }
                break;
            }
            case 'v2StopPromptSending':{
                editTrigger = {
                    type: 'v2StopPromptSending',
                    indent: 0
                }
                break;
            }
            case 'v2QuickSearchChat':{
                editTrigger = {
                    type: 'v2QuickSearchChat',
                    value: '',
                    valueType: 'value',
                    indent: 0,
                    condition: 'loose',
                    depth: '3',
                    depthType: 'value',
                    outputVar: ''
                }
                break;
            }
            case 'v2GetAllLorebooks':{
                editTrigger = {
                    type: 'v2GetAllLorebooks',
                    outputVar: '',
                    indent: 0
                }
                break;
            }
            case 'v2RegexTest':{
                editTrigger = {
                    type: 'v2RegexTest',
                    value: '',
                    valueType: 'value',
                    regex: '',
                    regexType: 'value',
                    flags: '',
                    flagsType: 'value',
                    outputVar: '',
                    indent: 0
                }
                break;
            }
            case 'v2GetLorebookByName':{
                editTrigger = {
                    type: 'v2GetLorebookByName',
                    name: '',
                    nameType: 'value',
                    outputVar: '',
                    indent: 0
                }
                break;
            }
            case 'v2GetLorebookByIndex':{
                editTrigger = {
                    type: 'v2GetLorebookByIndex',
                    index: '',
                    indexType: 'value',
                    outputVar: '',
                    indent: 0
                }
                break;
            }
            case 'v2CreateLorebook':{
                editTrigger = {
                    type: 'v2CreateLorebook',
                    name: '',
                    nameType: 'value',
                    key: '',
                    keyType: 'value',
                    content: '',
                    contentType: 'value',
                    insertOrder: '100',
                    insertOrderType: 'value',
                    indent: 0
                }
                break;
            }
            case 'v2ModifyLorebookByIndex':{
                editTrigger = {
                    type: 'v2ModifyLorebookByIndex',
                    index: '',
                    indexType: 'value',
                    name: '{{slot}}',
                    nameType: 'value',
                    key: '{{slot}}',
                    keyType: 'value',
                    content: '{{slot}}',
                    contentType: 'value',
                    insertOrder: '{{slot}}',
                    insertOrderType: 'value',
                    indent: 0
                }
                break;
            }
            case 'v2DeleteLorebookByIndex':{
                editTrigger = {
                    type: 'v2DeleteLorebookByIndex',
                    index: '',
                    indexType: 'value',
                    indent: 0
                }
                break;
            }
            case 'v2GetLorebookCountNew':{
                editTrigger = {
                    type: 'v2GetLorebookCountNew',
                    outputVar: '',
                    indent: 0
                }
                break;
            }
            case 'v2SetLorebookAlwaysActive':{
                editTrigger = {
                    type: 'v2SetLorebookAlwaysActive',
                    index: '',
                    indexType: 'value',
                    value: true,
                    indent: 0
                }
                break;
            }
            case 'v2GetReplaceGlobalNote':{
                editTrigger = {
                    type: 'v2GetReplaceGlobalNote',
                    outputVar: '',
                    indent: 0
                }
                break;
            }
            case 'v2SetReplaceGlobalNote':{
                editTrigger = {
                    type: 'v2SetReplaceGlobalNote',
                    value: '',
                    valueType: 'value',
                    indent: 0
                }
                break;
            }
            case 'v2GetAuthorNote':{
                editTrigger = {
                    type: 'v2GetAuthorNote',
                    outputVar: '',
                    indent: 0
                }
                break;
            }
            case 'v2SetAuthorNote':{
                editTrigger = {
                    type: 'v2SetAuthorNote',
                    value: '',
                    valueType: 'value',
                    indent: 0
                }
                break;
            }
            case 'v2MakeDictVar':{
                editTrigger = {
                    type: 'v2MakeDictVar',
                    var: '',
                    indent: 0
                }
                break;
            }
            case 'v2GetDictVar':{
                editTrigger = {
                    type: 'v2GetDictVar',
                    var: '',
                    varType: 'value',
                    key: '',
                    keyType: 'value',
                    outputVar: '',
                    indent: 0
                }
                break;
            }
            case 'v2SetDictVar':{
                editTrigger = {
                    type: 'v2SetDictVar',
                    var: '',
                    varType: 'value',
                    key: '',
                    keyType: 'value',
                    value: '',
                    valueType: 'value',
                    indent: 0
                }
                break;
            }
            case 'v2DeleteDictKey':{
                editTrigger = {
                    type: 'v2DeleteDictKey',
                    var: '',
                    varType: 'value',
                    key: '',
                    keyType: 'value',
                    indent: 0
                }
                break;
            }
            case 'v2HasDictKey':{
                editTrigger = {
                    type: 'v2HasDictKey',
                    var: '',
                    varType: 'value',
                    key: '',
                    keyType: 'value',
                    outputVar: '',
                    indent: 0
                }
                break;
            }
            case 'v2ClearDict':{
                editTrigger = {
                    type: 'v2ClearDict',
                    var: '',
                    indent: 0
                }
                break;
            }
            case 'v2GetDictSize':{
                editTrigger = {
                    type: 'v2GetDictSize',
                    var: '',
                    varType: 'value',
                    outputVar: '',
                    indent: 0
                }
                break;
            }
            case 'v2GetDictKeys':{
                editTrigger = {
                    type: 'v2GetDictKeys',
                    var: '',
                    varType: 'value',
                    outputVar: '',
                    indent: 0
                }
                break;
            }
            case 'v2GetDictValues':{
                editTrigger = {
                    type: 'v2GetDictValues',
                    var: '',
                    varType: 'value',
                    outputVar: '',
                    indent: 0
                }
                break;
            }
            case 'v2Calculate':{
                editTrigger = {
                    type: 'v2Calculate',
                    expression: '',
                    expressionType: 'value',
                    outputVar: '',
                    indent: 0
                }
                break;
            }
            case 'v2ReplaceString':{
                editTrigger = {
                    type: 'v2ReplaceString',
                    source: '',
                    sourceType: 'value',
                    regex: '',
                    regexType: 'value',
                    result: '',
                    resultType: 'value',
                    replacement: '',
                    replacementType: 'value',
                    flags: '',
                    flagsType: 'value',
                    outputVar: '',
                    indent: 0
                }
                break;
            }
            case 'v2Comment':{
                editTrigger = {
                    type: 'v2Comment',
                    value: '',
                    indent: 0
                }
                break;
            }
            case 'v2DeclareLocalVar':{
                editTrigger = {
                    type: 'v2DeclareLocalVar',
                    var: '',
                    value: '',
                    valueType: 'value',
                    indent: 0
                }
                break;
            }
        }
    }

    const deleteEffect = () => {
        const type = value[selectedIndex].effect[selectedEffectIndex]
        value[selectedIndex].effect.splice(selectedEffectIndex, 1)
        if(type.type === 'v2If' || type.type === 'v2IfAdvanced' || type.type === 'v2Loop' || type.type === 'v2Else' || type.type === 'v2LoopNTimes'){
            let pointer = selectedEffectIndex
            let indent = (type as triggerEffectV2).indent
            while(pointer < value[selectedIndex].effect.length){
                if(value[selectedIndex].effect[pointer].type === 'v2EndIndent' && (value[selectedIndex].effect[pointer] as triggerEffectV2).indent === indent + 1){
                    value[selectedIndex].effect.splice(pointer, 1)
                    if(value?.[selectedIndex]?.effect?.[pointer]?.type === 'v2Else'){
                        value[selectedIndex].effect.splice(pointer, 1)
                        continue
                    }
                    else{
                        break
                    }
                }
                (value[selectedIndex].effect[pointer] as triggerEffectV2).indent -= 1
                pointer += 1
            }
        }


        selectedEffectIndex -= 1
        if(selectedEffectIndex < 0){
            selectedEffectIndex = 0
        }
        updateGuideLines()
    }

    const copyEffect = () => {
        const type = value[selectedIndex].effect[selectedEffectIndex]
        
        if(type.type === 'v2If' || type.type === 'v2IfAdvanced' || type.type === 'v2Loop' || type.type === 'v2LoopNTimes'){
            const blockRange = getBlockRange(selectedEffectIndex)
            const blockEffects = value[selectedIndex].effect.slice(blockRange.start, blockRange.end + 1)
            clipboard = {
                type: 'effect',
                value: safeStructuredClone(blockEffects)
            }
            return
        }
        
        if(type.type === 'v2Else'){
            return
        }
        
        clipboard = {
            type: 'effect',
            value: safeStructuredClone([type])
        }
    }

    const getInsertIndent = (insertIndex: number): number => {
        if (insertIndex === 0) {
            return 0
        }
        
        if (insertIndex >= value[selectedIndex].effect.length) {
            if (value[selectedIndex].effect.length === 0) {
                return 0
            }
            const lastEffect = value[selectedIndex].effect[value[selectedIndex].effect.length - 1] as triggerEffectV2
            if (lastEffect.type === 'v2EndIndent') {
                return lastEffect.indent - 1
            }
            return lastEffect.indent
        }
        
        const targetEffect = value[selectedIndex].effect[insertIndex] as triggerEffectV2
        const prevEffect = insertIndex > 0 ? value[selectedIndex].effect[insertIndex - 1] as triggerEffectV2 : null
        
        if (targetEffect.type === 'v2EndIndent') {
            return targetEffect.indent
        }
        
        if (targetEffect.type === 'v2Else') {
            return targetEffect.indent
        }
        
        if (prevEffect && (prevEffect.type === 'v2If' || prevEffect.type === 'v2IfAdvanced' || 
                          prevEffect.type === 'v2Loop' || prevEffect.type === 'v2LoopNTimes')) {
            return prevEffect.indent + 1
        }
        
        if (prevEffect && prevEffect.type === 'v2Else') {
            return prevEffect.indent + 1
        }
        
        if (prevEffect && prevEffect.type === 'v2EndIndent') {
            return prevEffect.indent - 1
        }
        
        if (prevEffect) {
            return prevEffect.indent
        }
        
        return targetEffect.indent
    }

    const pasteEffect = async () => {
        if(clipboard?.type !== 'effect'){
            return
        }

        let insertIndex = selectedEffectIndex === -1 ? value[selectedIndex].effect.length : selectedEffectIndex
        const targetIndent = getInsertIndent(insertIndex)
        
        const firstEffect = clipboard.value[0] as triggerEffectV2
        const isBlock = firstEffect && (
            firstEffect.type === 'v2If' || 
            firstEffect.type === 'v2IfAdvanced' || 
            firstEffect.type === 'v2Loop' || 
            firstEffect.type === 'v2LoopNTimes'
        )
        
        if (isBlock) {
            const baseIndent = firstEffect.indent
            const indentDifference = targetIndent - baseIndent
            
            for(const effect of clipboard.value){
                const clonedEffect = safeStructuredClone(effect) as triggerEffectV2
                clonedEffect.indent = (effect as triggerEffectV2).indent + indentDifference
                value[selectedIndex].effect.splice(insertIndex, 0, clonedEffect)
                insertIndex += 1
            }
        } else {
            for(const effect of clipboard.value){
                const clonedEffect = safeStructuredClone(effect) as triggerEffectV2
                clonedEffect.indent = targetIndent
                value[selectedIndex].effect.splice(insertIndex, 0, clonedEffect)
                insertIndex += 1
            }
        }
        
        selectedEffectIndex = insertIndex - 1
        updateGuideLines()
    }

    const copyTrigger = () => {
        if (isMultipleSelected()) {
            const selectedTriggers = selectedTriggerIndices.map(index => value[index]).filter(Boolean)
            clipboard = {
                type: 'trigger',
                value: safeStructuredClone(selectedTriggers)
            }
        } else {
            clipboard = {
                type: 'trigger',
                value: safeStructuredClone([value[selectedIndex]])
            }
        }
    }

    const pasteTrigger = async () => {
        if(clipboard?.type !== 'trigger'){
            return
        }

        let insertIndex = selectedIndex
        for(const trigger of clipboard.value){
            value.splice(insertIndex, 0, safeStructuredClone(trigger))
            insertIndex += 1
        }
        selectedIndex = insertIndex - 1
        clearTriggerSelection()
    }

    const deleteTrigger = () => {
        if (isMultipleSelected()) {
            if (selectedTriggerIndices.length >= value.length - 1) {
                return
            }
            
            const sortedIndices = [...selectedTriggerIndices].sort((a, b) => b - a)
            for (const index of sortedIndices) {
                if (index > 0 && index < value.length) {
                    value.splice(index, 1)
                }
            }
            
            clearTriggerSelection()
            selectedIndex = Math.max(1, Math.min(selectedIndex, value.length - 1))
        } else {
            if(value.length <= 2){
                return
            }
            value.splice(selectedIndex, 1)
            selectedIndex -= 1
            if(selectedIndex < 1){
                selectedIndex = 1
            }
            clearTriggerSelection()
        }
    }

    const moveTrigger = (fromIndex: number, toIndex: number) => {
        if (fromIndex === toIndex || fromIndex === 0 || toIndex === 0) return;
        if (fromIndex < 0 || toIndex < 0 || fromIndex >= value.length || toIndex > value.length) return;
        if (!value[fromIndex]) return;
        
        if (isMultipleSelected() && isTriggerSelected(fromIndex)) {
            moveMultipleTriggers(toIndex);
        } else {
            let triggers = [...value];
            const movedItem = triggers.splice(fromIndex, 1)[0];
            if (!movedItem) return;
            
            const adjustedToIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
            triggers.splice(adjustedToIndex, 0, movedItem);
            
            if (selectedIndex === fromIndex) {
                selectedIndex = adjustedToIndex;
            } else if (fromIndex < selectedIndex && adjustedToIndex >= selectedIndex) {
                selectedIndex = selectedIndex - 1;
            } else if (fromIndex > selectedIndex && adjustedToIndex <= selectedIndex) {
                selectedIndex = selectedIndex + 1;
            }
            
            value = triggers;
        }
    }

    const moveMultipleTriggers = (toIndex: number) => {
        const sortedIndices = [...selectedTriggerIndices].sort((a, b) => a - b);
        const triggersToMove = sortedIndices.map(index => value[index]);
        
        let triggers = [...value];
        
        for (let i = sortedIndices.length - 1; i >= 0; i--) {
            triggers.splice(sortedIndices[i], 1);
        }
        
        let insertIndex = toIndex;
        for (let i = 0; i < sortedIndices.length; i++) {
            if (sortedIndices[i] < toIndex) {
                insertIndex--;
            }
        }
        
        insertIndex = Math.max(1, insertIndex);
        
        for (let i = 0; i < triggersToMove.length; i++) {
            triggers.splice(insertIndex + i, 0, triggersToMove[i]);
        }
        
        const newSelectedIndices = [];
        for (let i = 0; i < triggersToMove.length; i++) {
            newSelectedIndices.push(insertIndex + i);
        }
        
        selectedTriggerIndices = newSelectedIndices;
        selectedIndex = newSelectedIndices[0];
        lastSelectedTriggerIndex = newSelectedIndices[0];
        
        value = triggers;
    }

    const handleTriggerDrop = (targetIndex: number, e) => {
        e.preventDefault();
        e.stopPropagation();
        const data = e.dataTransfer?.getData('text');
        if (data === 'trigger') {
            const sourceIndex = parseInt(e.dataTransfer?.getData('triggerIndex') || '0');
            moveTrigger(sourceIndex, targetIndex);
        }
    }

    const getBlockRange = (startIndex: number): { start: number, end: number } => {
        if (!value || !value[selectedIndex] || !value[selectedIndex].effect) {
            return { start: startIndex, end: startIndex };
        }
        
        const effects = value[selectedIndex].effect;
        const startEffect = effects[startIndex] as triggerEffectV2;
        
        if (!startEffect || 
            (startEffect.type !== 'v2If' && startEffect.type !== 'v2IfAdvanced' && 
             startEffect.type !== 'v2Loop' && startEffect.type !== 'v2LoopNTimes')) {
            return { start: startIndex, end: startIndex };
        }
        
        let pointer = startIndex + 1;
        const indent = startEffect.indent;
        
        while (pointer < effects.length) {
            const currentEffect = effects[pointer] as triggerEffectV2;
            if (currentEffect.type === 'v2EndIndent' && currentEffect.indent === indent + 1) {
                let endIndex = pointer;
                
                if (pointer + 1 < effects.length) {
                    const nextEffect = effects[pointer + 1] as triggerEffectV2;
                    if (nextEffect.type === 'v2Else' && nextEffect.indent === indent) {
                        pointer += 2;
                        while (pointer < effects.length) {
                            const elseEffect = effects[pointer] as triggerEffectV2;
                            if (elseEffect.type === 'v2EndIndent' && elseEffect.indent === indent + 1) {
                                endIndex = pointer;
                                break;
                            }
                            pointer++;
                        }
                    }
                }
                
                return { start: startIndex, end: endIndex };
            }
            pointer++;
        }
        
        return { start: startIndex, end: startIndex };
    }

    const canMoveEffect = (fromIndex: number, toIndex: number): boolean => {
        if (!value || !value[selectedIndex] || !value[selectedIndex].effect) return false;
        if (fromIndex === toIndex) return false;
        if (fromIndex < 0 || toIndex < 0) return false;
        if (fromIndex >= value[selectedIndex].effect.length || toIndex > value[selectedIndex].effect.length) return false;
        
        const fromEffect = value[selectedIndex].effect[fromIndex] as triggerEffectV2;
        if (!fromEffect) return false;
        
        if (fromEffect.type === 'v2EndIndent' || fromEffect.type === 'v2Else') {
            return false;
        }
        
        if (fromEffect.type === 'v2If' || fromEffect.type === 'v2IfAdvanced' || 
            fromEffect.type === 'v2Loop' || fromEffect.type === 'v2LoopNTimes') {
            const blockRange = getBlockRange(fromIndex);
            
            if (toIndex > blockRange.start && toIndex <= blockRange.end + 1) {
                return false;
            }
        }
        
        if (toIndex < value[selectedIndex].effect.length) {
            const targetEffect = value[selectedIndex].effect[toIndex] as triggerEffectV2;
            if (targetEffect && targetEffect.type === 'v2Else' && toIndex > 0) {
                const prevEffect = value[selectedIndex].effect[toIndex - 1] as triggerEffectV2;
                if (prevEffect && prevEffect.type === 'v2EndIndent') {
                    const blockIndent = prevEffect.indent - 1;
                    for (let i = toIndex - 2; i >= 0; i--) {
                        const checkEffect = value[selectedIndex].effect[i] as triggerEffectV2;
                        if (checkEffect.indent === blockIndent) {
                            if (checkEffect.type === 'v2If' || checkEffect.type === 'v2IfAdvanced') {
                                return false;
                            }
                            break;
                        }
                    }
                }
            }
        }

        if (toIndex > 0 && toIndex < value[selectedIndex].effect.length) {
            const prevEffect = value[selectedIndex].effect[toIndex - 1] as triggerEffectV2;
            const targetEffect = value[selectedIndex].effect[toIndex] as triggerEffectV2;
            
            if (prevEffect && prevEffect.type === 'v2EndIndent' && 
                targetEffect && targetEffect.type === 'v2Else') {
                return false;
            }
        }

        try {
            const targetIndent = getInsertIndent(toIndex);
            if (targetIndent < 0 || targetIndent > 10) {
                return false;
            }
        } catch(e) {
            return false;
        }
        
        return true;
    }

    const moveEffect = (fromIndex: number, toIndex: number) => {
        if (!canMoveEffect(fromIndex, toIndex)) return;
        
        let effects = [...value[selectedIndex].effect];
        const fromEffect = effects[fromIndex] as triggerEffectV2;
        
        if (fromEffect.type === 'v2If' || fromEffect.type === 'v2IfAdvanced' || 
            fromEffect.type === 'v2Loop' || fromEffect.type === 'v2LoopNTimes') {
            
            const blockRange = getBlockRange(fromIndex);
            const blockSize = blockRange.end - blockRange.start + 1;
            
            const targetIndent = getInsertIndent(toIndex);
            
            const movedBlock = effects.splice(blockRange.start, blockSize);
            if (movedBlock.length === 0) return;
                
            const adjustedToIndex = blockRange.start < toIndex ? toIndex - blockSize : toIndex;
            
            const originalIndent = (movedBlock[0] as triggerEffectV2).indent;
            const indentDifference = targetIndent - originalIndent;
            
            movedBlock.forEach((effect) => {
                const effectV2 = effect as triggerEffectV2;
                effectV2.indent += indentDifference;
            });
            
            effects.splice(adjustedToIndex, 0, ...movedBlock);
            
            if (selectedEffectIndex >= blockRange.start && selectedEffectIndex <= blockRange.end) {
                const offsetInBlock = selectedEffectIndex - blockRange.start;
                selectedEffectIndex = adjustedToIndex + offsetInBlock;
            } else if (blockRange.start < selectedEffectIndex && adjustedToIndex >= selectedEffectIndex) {
                selectedEffectIndex = selectedEffectIndex - blockSize;
            } else if (blockRange.start > selectedEffectIndex && adjustedToIndex <= selectedEffectIndex) {
                selectedEffectIndex = selectedEffectIndex + blockSize;
            }
            
        } else {
            const targetIndent = getInsertIndent(toIndex);
            
            const movedItem = effects.splice(fromIndex, 1)[0];
            if (!movedItem) return;
            
            const adjustedToIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
            
            (movedItem as triggerEffectV2).indent = targetIndent;
            
            effects.splice(adjustedToIndex, 0, movedItem);
            
            if (selectedEffectIndex === fromIndex) {
                selectedEffectIndex = adjustedToIndex;
            } else if (fromIndex < selectedEffectIndex && adjustedToIndex >= selectedEffectIndex) {
                selectedEffectIndex = selectedEffectIndex - 1;
            } else if (fromIndex > selectedEffectIndex && adjustedToIndex <= selectedEffectIndex) {
                selectedEffectIndex = selectedEffectIndex + 1;
            }
        }
        
        value[selectedIndex].effect = effects;
        updateGuideLines();
    }

    const handleEffectDrop = (targetIndex: number, e) => {
        e.preventDefault();
        e.stopPropagation();
        const data = e.dataTransfer?.getData('text');
        if (data === 'effect') {
            const sourceIndex = parseInt(e.dataTransfer?.getData('effectIndex') || '0');
            moveEffect(sourceIndex, targetIndex);
        }
    }

    const handleKeydown = (e:KeyboardEvent) => {
        if(e.key === 'Escape'){
            if(contextMenu){
                contextMenu = false
                return
            }
            if(menuMode === 0){
                close()
            }
            else{
                if(selectedIndex > 0) {
                    selectedTriggerIndex = selectedIndex;
                    selectedEffectIndexSaved = selectedEffectIndex;
                }
                menuMode = 0
            }
        }
        if(selectedIndex > 0 && selectedEffectIndex !== -1 && menuMode === 0 && selectMode === 1){
            if(e.key === 'ArrowUp'){
                if(selectedEffectIndex > 0){
                    selectedEffectIndex -= 1

                    if(e.altKey){
                        const before = value[selectedIndex].effect[selectedEffectIndex] as triggerEffectV2
                        const after = value[selectedIndex].effect[selectedEffectIndex + 1] as triggerEffectV2
                        if(
                            before.type !== 'v2EndIndent' && after.type !== 'v2EndIndent'
                            && before.type !== 'v2If' && after.type !== 'v2If'
                            && before.type !== 'v2IfAdvanced' && after.type !== 'v2IfAdvanced'
                            && before.type !== 'v2Loop' && after.type !== 'v2Loop'
                            && before.type !== 'v2LoopNTimes' && after.type !== 'v2LoopNTimes'
                            && before.indent === after.indent
                        ){
                            value[selectedIndex].effect[selectedEffectIndex] = after
                            value[selectedIndex].effect[selectedEffectIndex + 1] = before
                        }
                    }
                }
                e.preventDefault()
            }
            if(e.key === 'ArrowDown'){
                if(selectedEffectIndex < value[selectedIndex].effect.length - 1){
                    selectedEffectIndex += 1

                    if(e.altKey){
                        const before = value[selectedIndex].effect[selectedEffectIndex] as triggerEffectV2
                        const after = value[selectedIndex].effect[selectedEffectIndex - 1] as triggerEffectV2
                        if(
                            before.type !== 'v2EndIndent' && after.type !== 'v2EndIndent'
                            && before.type !== 'v2If' && after.type !== 'v2If'
                            && before.type !== 'v2IfAdvanced' && after.type !== 'v2IfAdvanced'
                            && before.type !== 'v2Loop' && after.type !== 'v2Loop'
                            && before.type !== 'v2LoopNTimes' && after.type !== 'v2LoopNTimes'
                            && before.indent === after.indent
                        ){
                            value[selectedIndex].effect[selectedEffectIndex] = after
                            value[selectedIndex].effect[selectedEffectIndex - 1] = before
                        }
                    }
                }
                e.preventDefault()
            }
            if(e.key === 'c' && e.ctrlKey){
                copyEffect()
                e.preventDefault()
            }
            if(e.key === 'v' && e.ctrlKey){
                //paste
                pasteEffect()
                e.preventDefault()
            }
            if(e.key === 'Delete'){
                deleteEffect()
                e.preventDefault()
            }
        }
        if(selectedIndex > 0 && menuMode === 0 && selectMode === 0){
            if(e.key === 'ArrowUp'){
                if(selectedIndex > 1){
                    selectedIndex -= 1

                    if(e.altKey){
                        const before = value[selectedIndex]
                        const after = value[selectedIndex + 1]
                        value[selectedIndex] = after
                        value[selectedIndex + 1] = before
                    }
                }
                e.preventDefault()
            }
            if(e.key === 'ArrowDown'){
                if(selectedIndex < value.length - 1){
                    selectedIndex += 1

                    if(e.altKey){
                        const before = value[selectedIndex]
                        const after = value[selectedIndex - 1]
                        value[selectedIndex] = after
                        value[selectedIndex - 1] = before
                    }
                }
                e.preventDefault()
            }
            if(e.key === 'c' && e.ctrlKey){
                copyTrigger()
                e.preventDefault()
            }
            if(e.key === 'v' && e.ctrlKey){
                pasteTrigger()
                e.preventDefault()
            }
            //Delete is forrbidden due to the fact that misclicks can cause huge data loss
        }
    }

    const handleContextMenu = (e, mode, effectIndex = -1, effect = null) => {
        contextMenu = true
        selectMode = mode
        
        const clickPos = {x: e.clientX, y: e.clientY}
        
        const yPosition = clickPos.y > (window.innerHeight * 0.75)
            ? `bottom: ${window.innerHeight - clickPos.y}px;`
            : `top: ${clickPos.y}px;`
        
        const xPosition = clickPos.x > (window.innerWidth * 0.75)
            ? `right: ${window.innerWidth - clickPos.x}px;`
            : `left: ${clickPos.x}px;`
        
        contextMenuLoc = {
            x: clickPos.x, 
            y: clickPos.y,
            style: `${yPosition} ${xPosition}`
        }
        
        if (mode === 1) {
            selectedEffectIndex = effectIndex
            
            if (effect) {
                editTrigger = effect as triggerEffectV2
            }
        } else if (mode === 0) {
            if (!isTriggerSelected(effectIndex)) {
                selectedTriggerIndices = [effectIndex]
                lastSelectedTriggerIndex = effectIndex
                selectedIndex = effectIndex
            }
        }
        
        e.preventDefault()
        e.stopPropagation()
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
    
    const updateGuideLines = () => {
        guideLineKey += 1
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
                                    moveEffect(fromIndex, effectIndex)
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
