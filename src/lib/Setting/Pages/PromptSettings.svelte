<script lang="ts">
    import { SvelteSet } from "svelte/reactivity";
    import { PlusIcon, TriangleAlertIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import PromptDataItem from "src/lib/UI/PromptDataItem.svelte";
    import { tokenizePreset, type PromptItem } from "src/ts/process/prompt";
    import { templateCheck, type TemplateWarning } from "src/ts/process/templates/templateCheck";
    
    import { applyHypaPresetIntegration } from "src/ts/storage/database.svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import SettingRenderer from "src/lib/Setting/SettingRenderer.svelte";
    import type { SettingItem } from "src/ts/setting/types";
    import { getAbortSignal, onDestroy, onMount } from "svelte";
    import SortableList from "../../UI/components/SortableList.svelte";
    import IconButton from "../../UI/components/IconButton.svelte";
    import IconButtonGroup from "../../UI/components/IconButtonGroup.svelte";
    import ActionBar from "../../UI/components/ActionBar.svelte";
    import Alert from "../../UI/components/Alert.svelte";
    import SettingLayout from "../Wrappers/SettingLayout.svelte";
    import Help from "../../Others/Help.svelte";

    const warns: TemplateWarning[] = $derived(templateCheck(DBState.db))
    let tokens = $state(0)
    let rawTokens = $state(0)
    const openedItems = new SvelteSet<PromptItem>()
    const promptProcessingItems: SettingItem[] = [
        { id: 'prompt.systemContentReplacement', type: 'text', labelKey: 'systemContentReplacement', helpKey: 'systemContentReplacement', bindKey: 'systemContentReplacement' },
        {
            id: 'prompt.systemRoleReplacement', type: 'select', labelKey: 'systemRoleReplacement', helpKey: 'systemRoleReplacement', bindKey: 'systemRoleReplacement',
            options: { selectOptions: [{ value: 'user', label: 'User' }, { value: 'assistant', label: 'Assistant' }] },
        },
        { id: 'prompt.sendChatAsSystem', type: 'check', labelKey: 'presetSendPastChatsAsSystem', helpKey: 'presetSendPastChatsAsSystem', bindPath: 'promptSettings.sendChatAsSystem' },
        { id: 'prompt.trimStartNewChat', type: 'check', labelKey: 'trimStartNewChat', helpKey: 'trimStartNewChat', bindPath: 'promptSettings.trimStartNewChat' },
    ]
    const promptCustomItems: SettingItem[] = [
        { id: 'prompt.moduleIntegration', type: 'text', labelKey: 'moduleIntergration', helpKey: 'moduleIntergration', bindKey: 'moduleIntergration' },
        {
            id: 'prompt.hypaIntegration', type: 'text', labelKey: 'hypaPresetIntegration', helpKey: 'hypaPresetIntegration',
            getValue: (db) => db.hypaPresetIntegration ?? '',
            setValue: (db, value: string) => {
                db.hypaPresetIntegration = value
                applyHypaPresetIntegration(db)
            },
        },
        { id: 'prompt.customToggle', type: 'textarea', labelKey: 'customPromptTemplateToggle', helpKey: 'customPromptTemplateToggle', bindKey: 'customPromptTemplateToggle' },
        { id: 'prompt.defaultVariables', type: 'textarea', labelKey: 'defaultVariables', helpKey: 'defaultVariables', bindKey: 'templateDefaultVariables' },
    ]
    const promptJsonSchemaItems: SettingItem[] = [
        { id: 'prompt.jsonEnabled', type: 'check', labelKey: 'presetEnableJsonSchema', helpKey: 'presetEnableJsonSchema', bindKey: 'jsonSchemaEnabled' },
        { id: 'prompt.jsonStrict', type: 'check', labelKey: 'strictJsonSchema', helpKey: 'strictJsonSchema', bindKey: 'strictJsonSchema', condition: (ctx) => ctx.db.jsonSchemaEnabled },
        { id: 'prompt.jsonSchema', type: 'textarea', labelKey: 'jsonSchema', helpKey: 'jsonSchema', bindKey: 'jsonSchema', condition: (ctx) => ctx.db.jsonSchemaEnabled },
        { id: 'prompt.extractJson', type: 'textarea', labelKey: 'extractJson', helpKey: 'extractJson', bindKey: 'extractJson', condition: (ctx) => ctx.db.jsonSchemaEnabled },
    ]

  interface Props {
    onGoBack?: () => void;
    mode?: 'independent'|'inline';
    subMenu?: number;
  }

  let { onGoBack = () => {}, mode = 'independent', subMenu = $bindable(0) }: Props = $props();

    async function executeTokenize(prest: PromptItem[], signal: AbortSignal){
        const [parsed, raw] = await Promise.all([tokenizePreset(prest), tokenizePreset(prest, 'raw')])
        if (signal.aborted) return
        tokens = parsed
        rawTokens = raw
    }

    function warningText(warning: TemplateWarning): string {
        if (warning.kind === 'missingChatEnd') {
            return language.promptTemplateWarnings.missingChatEnd
        }
        if (warning.kind === 'unconnectedChatRanges') {
            return language.promptTemplateWarnings.unconnectedChatRanges(warning.ranges.join(', '))
        }

        const item = language.formating[warning.item]
        return warning.kind === 'missing'
            ? language.promptTemplateWarnings.missing(item)
            : language.promptTemplateWarnings.multiple(item)
    }

    $effect.pre(() => {
    // Snapshot synchronously so every block is tracked, not just those read before the first await.
    executeTokenize($state.snapshot(DBState.db.promptTemplate), getAbortSignal())
  });

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey && e.altKey && e.key === 'o') {
      const openAll = openedItems.size !== DBState.db.promptTemplate.length
      openedItems.clear()
      if (openAll) {
        for (const item of DBState.db.promptTemplate) openedItems.add(item)
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
    <Alert variant="destructive" className="mt-4">
        {#snippet icon()}<TriangleAlertIcon />{/snippet}
        {#snippet title()}{language.promptTemplateWarnings.title}{/snippet}
        <ul class="m-0 list-disc space-y-1 pl-4">
            {#each warns as warn}
                <li>{warningText(warn)}</li>
            {/each}
        </ul>
    </Alert>
{/if}

{#if subMenu === 0}
    <SortableList
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
                <div class="text-subtext">No Format</div>
        {/if}
        {#each DBState.db.promptTemplate as prompt, originalIndex}
                <PromptDataItem
                    bind:promptItem={DBState.db.promptTemplate[originalIndex]}
                    isOpened={openedItems.has(prompt)}
                    onToggle={() => {
                        if (!openedItems.delete(prompt)) openedItems.add(prompt)
                    }}
                    currentIndex={originalIndex}
                    onRemove={() => {
                        DBState.db.promptTemplate.splice(originalIndex, 1)
                        openedItems.delete(prompt)
                    }}
                />
        {/each}
    </SortableList>

    <ActionBar mode="footer" className="justify-between">
        <IconButtonGroup>
            <IconButton size="lg" onclick={() => {
                let value = DBState.db.promptTemplate
                value.push({
                    type: "plain",
                    text: "",
                    role: "system",
                    type2: 'normal'
                })
                DBState.db.promptTemplate = value
            }}><PlusIcon /></IconButton>
        </IconButtonGroup>
        <span class="flex items-center text-sm text-subtext">
            {tokens}({rawTokens}) {language.tokens}
            <Help key="promptTemplateTokens" name={language.tokens} />
        </span>
    </ActionBar>
{:else}
    <SettingRenderer items={promptProcessingItems} layout="row" />

    <SettingLayout variant="section" title={language.presetToggleAndCustom}>
        <SettingRenderer items={promptCustomItems} layout="row" />
    </SettingLayout>

    <SettingLayout variant="section" title={language.jsonSchema}>
        <SettingRenderer items={promptJsonSchemaItems} layout="row" />
    </SettingLayout>

{/if}
