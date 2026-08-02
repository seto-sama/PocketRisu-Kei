<script lang="ts">
    import { TrashIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { alertConfirm } from "src/ts/alert";
    import type { triggerEffectV2 } from "src/ts/process/triggers";
    import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";
    import IconButton from "src/lib/UI/GUI/IconButton.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import ShDisclosureList from "src/lib/UI/GUI/ShDisclosureList.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";

    interface Props {
        value: triggerEffectV2;
        open?: boolean;
        removable?: boolean;
        showElse?: boolean;
        hasElse?: boolean;
        titleHtml?: string;
        triggerNames?: string[];
        onToggle?: () => void;
        onRemove?: () => void;
        onElseChange?: (checked: boolean) => void;
    }

    let {
        value = $bindable(),
        open = false,
        removable = true,
        showElse = false,
        hasElse = false,
        titleHtml = '',
        triggerNames = [],
        onToggle = () => {},
        onRemove = () => {},
        onElseChange = () => {},
    }: Props = $props();

    let effect = $derived(value as any);
    let fields = $derived(Object.keys(effect).filter((field) => field !== 'type' && field !== 'indent' && field !== 'endOfLoop'));

    const multilineFields = new Set([
        'value', 'prompt', 'content', 'source', 'target', 'replacement', 'result',
        'expression', 'code', 'systemPrompt', 'activationKeys',
    ]);

    const comparisonOptions = [
        ['=', language.triggerInputLabels.conditionEqual],
        ['!=', language.triggerInputLabels.conditionNotEqual],
        ['>', language.triggerInputLabels.conditionGreater],
        ['<', language.triggerInputLabels.conditionLess],
        ['>=', language.triggerInputLabels.conditionGreaterEqual],
        ['<=', language.triggerInputLabels.conditionLessEqual],
        ['≒', language.triggerInputLabels.conditionSimilar],
        ['∋', language.triggerInputLabels.conditionContains],
        ['∈', language.triggerInputLabels.conditionIn],
        ['∌', language.triggerInputLabels.conditionNotContains],
        ['∉', language.triggerInputLabels.conditionNotIn],
        ['≡', language.triggerInputLabels.conditionTruthy],
    ];

    const operatorOptions = [
        ['=', language.triggerInputLabels.operatorSet],
        ['+=', language.triggerInputLabels.operatorAdd],
        ['-=', language.triggerInputLabels.operatorSubtract],
        ['*=', language.triggerInputLabels.operatorMultiply],
        ['/=', language.triggerInputLabels.operatorDivide],
        ['%=', language.triggerInputLabels.operatorModulo],
    ];

    function getLabel(field: string) {
        const labels = language.triggerInputLabels as Record<string, string>;
        return labels[field] ?? field.replace(/([a-z])([A-Z])/g, '$1 $2');
    }

    function getOptions(field: string): [string, string][] | null {
        if (value.type === 'v2RunTrigger' && field === 'target') {
            return triggerNames.map((name) => [name, name || 'Unnamed Trigger']);
        }
        if (value.type === 'v2QuickSearchChat' && field === 'condition') {
            return [['loose', 'loose'], ['strict', 'strict'], ['regex', 'regex']];
        }
        if ((value.type === 'v2If' || value.type === 'v2IfAdvanced') && field === 'target' && effect.condition === '≡') {
            return [
                ['true', language.triggerInputLabels.boolTrue],
                ['false', language.triggerInputLabels.boolFalse],
                ['null', language.triggerInputLabels.boolNull],
            ];
        }
        if (field.endsWith('Type') && field !== 'alertType') {
            return [
                ['value', language.triggerInputLabels.value],
                ['var', language.triggerInputLabels.var],
            ];
        }
        if (field === 'condition') return comparisonOptions as [string, string][];
        if (field === 'operator') return operatorOptions as [string, string][];
        if (field === 'model') {
            return [
                ['model', language.triggerInputLabels.modelMain],
                ['submodel', language.triggerInputLabels.modelSub],
            ];
        }
        if (field === 'location') {
            return [
                ['start', language.triggerInputLabels.sysStart],
                ['historyend', language.triggerInputLabels.sysHistoryEnd],
                ['promptend', language.triggerInputLabels.sysPromptEnd],
            ];
        }
        if (field === 'role') {
            if (value.type === 'v2Impersonate') {
                return [
                    ['user', language.triggerInputLabels.roleUser],
                    ['char', language.triggerInputLabels.roleChar],
                ];
            }
            return [
                ['system', language.systemPrompt],
                ['user', language.user],
                ['assistant', language.character],
                ['char', language.character],
            ];
        }
        return null;
    }

    async function removeEffect() {
        const name = language.triggerDesc[value.type] || value.type;
        if (await alertConfirm(language.removeConfirm + name)) onRemove();
    }
</script>

<ShDisclosureList
    variant="item"
    {open}
    onToggle={onToggle}
    dividerTone="muted"
    data-disclosure-drag-name={language.triggerDesc[value.type] || value.type}
>
    {#snippet header()}
        <div class="min-w-0 flex-1 break-all text-sm">
            {@html titleHtml || language.triggerDesc[value.type] || value.type}
        </div>
    {/snippet}
    {#snippet actions()}
        {#if removable}
            <IconButton tone="destructive" data-disclosure-action="delete" aria-label={language.remove} onclick={async (event) => {
                event.stopPropagation();
                await removeEffect();
            }}>
                <TrashIcon />
            </IconButton>
        {/if}
    {/snippet}

    {#if fields.length === 0}
        <span class="py-2 text-sm text-textcolor2">{language.noConfig}</span>
    {/if}

    {#each fields as field}
        {@const options = getOptions(field)}
        <div data-disclosure-field>
            <div data-disclosure-label>{getLabel(field)}</div>
            <div data-disclosure-control>
                {#if typeof effect[field] === 'boolean'}
                    <CheckInput
                        bind:check={effect[field]}
                        name={getLabel(field)}
                    />
                {:else if options}
                    <SelectInput bind:value={effect[field]}>
                        {#each options as option}
                            <OptionInput value={option[0]}>{option[1]}</OptionInput>
                        {/each}
                    </SelectInput>
                {:else if multilineFields.has(field)}
                    <TextAreaInput
                        highlight
                        height="20"
                        bind:value={effect[field]}
                    />
                {:else}
                    <TextInput
                        bind:value={effect[field]}
                    />
                {/if}
            </div>
        </div>
    {/each}

    {#if showElse}
        <div data-disclosure-row>
            <CheckInput
                check={hasElse}
                name={language.triggerInputLabels.addElse}
                onChange={onElseChange}
            />
        </div>
    {/if}
</ShDisclosureList>
