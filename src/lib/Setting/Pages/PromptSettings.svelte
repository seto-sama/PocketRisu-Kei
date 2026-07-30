<script lang="ts">
    import { PlusIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import PromptDataItem from "src/lib/UI/PromptDataItem.svelte";
    import { tokenizePreset, type PromptItem } from "src/ts/process/prompt";
    import { templateCheck } from "src/ts/process/templates/templateCheck";
    
    import { DBState } from 'src/ts/stores.svelte';
    import SettingRenderer from "src/lib/Setting/SettingRenderer.svelte";
    import type { SettingItem } from "src/ts/setting/types";
    import { onDestroy, onMount } from "svelte";
    import ShSortableList from "src/lib/UI/GUI/ShSortableList.svelte";
    import IconButton from "src/lib/UI/GUI/IconButton.svelte";

    let warns: string[] = $state([])
    let tokens = $state(0)
    let extokens = $state(0)
    let openedItems = $state(new Set<PromptItem>())
    const promptProcessingItems: SettingItem[] = [
        { id: 'prompt.sendChatAsSystem', type: 'check', labelKey: 'presetSendPastChatsAsSystem', bindPath: 'promptSettings.sendChatAsSystem' },
        { id: 'prompt.systemContentReplacement', type: 'text', labelKey: 'systemContentReplacement', helpKey: 'systemContentReplacement', bindKey: 'systemContentReplacement' },
        {
            id: 'prompt.systemRoleReplacement', type: 'select', labelKey: 'systemRoleReplacement', helpKey: 'systemRoleReplacement', bindKey: 'systemRoleReplacement',
            options: { selectOptions: [{ value: 'user', label: 'User' }, { value: 'assistant', label: 'Assistant' }] },
        },
        { id: 'prompt.trimStartNewChat', type: 'check', labelKey: 'trimStartNewChat', bindPath: 'promptSettings.trimStartNewChat' },
        {
            id: 'prompt.searchTool', type: 'check', labelKey: 'search', helpKey: 'searchTool',
            getValue: (db) => db.modelTools.includes('search'),
            setValue: (db, value: boolean) => {
                db.modelTools = value
                    ? [...db.modelTools.filter((tool) => tool !== 'search'), 'search']
                    : db.modelTools.filter((tool) => tool !== 'search')
            },
        },
    ]
    const promptCustomItems: SettingItem[] = [
        { id: 'prompt.moduleIntegration', type: 'text', labelKey: 'moduleIntergration', helpKey: 'moduleIntergration', bindKey: 'moduleIntergration' },
        { id: 'prompt.customToggle', type: 'textarea', labelKey: 'customPromptTemplateToggle', helpKey: 'customPromptTemplateToggle', bindKey: 'customPromptTemplateToggle' },
        { id: 'prompt.defaultVariables', type: 'textarea', labelKey: 'defaultVariables', helpKey: 'defaultVariables', bindKey: 'templateDefaultVariables' },
        { id: 'prompt.jsonEnabled', type: 'check', labelKey: 'presetEnableJsonSchema', bindKey: 'jsonSchemaEnabled' },
        { id: 'prompt.jsonStrict', type: 'check', labelKey: 'strictJsonSchema', bindKey: 'strictJsonSchema', condition: (ctx) => ctx.db.jsonSchemaEnabled },
        { id: 'prompt.jsonSchema', type: 'textarea', labelKey: 'jsonSchema', helpKey: 'jsonSchema', bindKey: 'jsonSchema', condition: (ctx) => ctx.db.jsonSchemaEnabled },
        { id: 'prompt.extractJson', type: 'text', labelKey: 'extractJson', helpKey: 'extractJson', bindKey: 'extractJson', condition: (ctx) => ctx.db.jsonSchemaEnabled },
    ]
    executeTokenize(DBState.db.promptTemplate)

  interface Props {
    onGoBack?: () => void;
    mode?: 'independent'|'inline';
    subMenu?: number;
  }

  let { onGoBack = () => {}, mode = 'independent', subMenu = $bindable(0) }: Props = $props();

    async function executeTokenize(prest: PromptItem[]){
        tokens = await tokenizePreset(prest, true)
        extokens = await tokenizePreset(prest, false)
    }

    $effect.pre(() => {
    warns = templateCheck(DBState.db)
  });
  $effect.pre(() => {
    executeTokenize(DBState.db.promptTemplate)
  });

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey && e.altKey && e.key === 'o') {
      if (openedItems.size === DBState.db.promptTemplate.length) {
        openedItems = new Set<PromptItem>()
      } else {
        openedItems = new Set(DBState.db.promptTemplate)
      }
    }
  }

  onMount(() => {
    document.addEventListener('keydown', handleKeyDown)
  })

  onDestroy(() => {
    document.removeEventListener('keydown', handleKeyDown)
  })
</script>
{#if mode === 'independent'}
    <div class="flex w-full rounded-md border border-selected">
        <button onclick={() => {
            subMenu = 0
        }} class="p-2 flex-1" class:bg-selected={subMenu === 0}>
            <span>{language.template}</span>
        </button>
        <button onclick={() => {
            subMenu = 1
        }} class="p-2 flex-1" class:bg-selected={subMenu === 1}>
            <span>{language.settings}</span>
        </button>
    </div>
{/if}
{#if warns.length > 0 && subMenu === 0}
    <div class="text-red-500 flex flex-col items-start p-2 rounded-md border-red-500 border mt-4">
        <h2 class="text-xl font-bold">Warning</h2>
        <div class="border-b border-b-red-500 mt-1 mb-2 w-full"></div>
        {#each warns as warn}
            <span class="ml-4">{warn}</span>
        {/each}
    </div>
{/if}

{#if subMenu === 0}
    <ShSortableList
        className="contain w-full max-w-full mt-4 flex flex-col"
        draggable="[data-risu-idx]"
        dataAttribute="data-risu-idx"
        handle="[data-disclosure-toggle]"
        onReorder={(orderedKeys) => {
            const templates = [...DBState.db.promptTemplate]
            DBState.db.promptTemplate = orderedKeys
                .map((key) => templates[Number.parseInt(key, 10)])
                .filter((item): item is PromptItem => !!item)
        }}
    >
        {#if DBState.db.promptTemplate.length === 0}
                <div class="text-textcolor2">No Format</div>
        {/if}
        {#each DBState.db.promptTemplate as prompt, originalIndex}
                <PromptDataItem
                    bind:promptItem={DBState.db.promptTemplate[originalIndex]}
                    isOpened={openedItems.has(prompt)}
                    onToggle={() => {
                        const nextOpenedItems = new Set(openedItems)
                        if (nextOpenedItems.has(prompt)) {
                            nextOpenedItems.delete(prompt)
                        } else {
                            nextOpenedItems.add(prompt)
                        }
                        openedItems = nextOpenedItems
                    }}
                    currentIndex={originalIndex}
                    onRemove={() => {
                        let templates = DBState.db.promptTemplate
                        templates.splice(originalIndex, 1)
                        DBState.db.promptTemplate = templates
                        openedItems.delete(prompt)
                        openedItems = new Set(openedItems)
                    }}
                />
        {/each}
    </ShSortableList>

    <div class="flex items-center mb-6">
        <IconButton size="lg" onclick={() => {
            let value = DBState.db.promptTemplate ?? []
            value.push({
                type: "plain",
                text: "",
                role: "system",
                type2: 'normal'
            })
            DBState.db.promptTemplate = value
        }}><PlusIcon /></IconButton>

        <div class="ml-auto flex items-center gap-2 text-textcolor2 text-sm">
            <span>{tokens} {language.fixedTokens}</span>
            <span aria-hidden="true">|</span>
            <span>{extokens} {language.exactTokens}</span>
        </div>
    </div>
{:else}
    <SettingRenderer items={promptProcessingItems} layout="row" />

    <h3 class="text-base font-bold mt-8 mb-1">{language.presetToggleAndCustom}</h3>
    <SettingRenderer items={promptCustomItems} layout="row" />

{/if}
