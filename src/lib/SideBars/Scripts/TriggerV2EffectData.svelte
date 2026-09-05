<script lang="ts">
    import { TrashIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { alertConfirm } from "src/ts/alert";
    import type { triggerEffectV2 } from "src/ts/process/triggers";
    import Checkbox from "../../UI/components/Checkbox.svelte";
    import IconButton from "../../UI/components/IconButton.svelte";
    import SelectOption from "../../UI/components/SelectOption.svelte";
    import Select from "../../UI/components/Select.svelte";
    import DisclosureList from "../../UI/components/DisclosureList.svelte";
    import Switch from "../../UI/components/Switch.svelte";
    import Textarea from "../../UI/components/Textarea.svelte";
    import Input from "../../UI/components/Input.svelte";

    interface Props {
        value: triggerEffectV2;
        open?: boolean;
        removable?: boolean;
        divider?: boolean;
        titleHtml?: string;
        triggerNames?: string[];
        onToggle?: () => void;
        onRemove?: () => void;
    }

    let {
        value = $bindable(),
        open = false,
        removable = true,
        divider = false,
        titleHtml = '',
        triggerNames = [],
        onToggle = () => {},
        onRemove = () => {},
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

    function isLorebookAlwaysActiveField(field: string) {
        return value.type === 'v2SetLorebookAlwaysActive' && field === 'value';
    }

    function getLabel(field: string) {
        if (isLorebookAlwaysActiveField(field)) {
            return language.triggerInputLabels.alwaysActive;
        }
        const labels = language.triggerInputLabels as Record<string, string>;
        if (field.endsWith('Type')) {
            const baseField = field.slice(0, -4);
            const baseLabel = labels[baseField] ?? baseField.replace(/([a-z])([A-Z])/g, '$1 $2');
            return `${baseLabel} ${labels.typeSuffix}`;
        }
        return labels[field] ?? field.replace(/([a-z])([A-Z])/g, '$1 $2');
    }

    function getOptions(field: string): [string, string][] | null {
        if (value.type === 'v2RunTrigger' && field === 'target') {
            return triggerNames.map((name) => [name, name || 'Unnamed Trigger']);
        }
        if (value.type === 'v2QuickSearchChat' && field === 'condition') {
            return [['loose', 'loose'], ['strict', 'strict'], ['regex', 'regex']];
        }
        if (value.type === 'v2IfAdvanced' && field === 'target' && effect.condition === '≡') {
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

<DisclosureList
    variant="item"
    {open}
    onToggle={onToggle}
    dividerTone="muted"
    isLast={!divider}
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
        <span class="py-2 text-sm text-subtext">{language.noConfig}</span>
    {/if}

    {#each fields as field}
        {@const options = getOptions(field)}
        {#if isLorebookAlwaysActiveField(field)}
            <div data-disclosure-row>
                <span>{getLabel(field)}</span>
                <Switch
                    bind:checked={effect[field]}
                    ariaLabel={getLabel(field)}
                />
            </div>
        {:else}
            <div data-disclosure-field>
                <div data-disclosure-label>{getLabel(field)}</div>
                <div data-disclosure-control>
                    {#if typeof effect[field] === 'boolean'}
                        <Checkbox
                            card
                            bind:check={effect[field]}
                            name={getLabel(field)}
                        />
                    {:else if options}
                        <Select bind:value={effect[field]}>
                            {#each options as option}
                                <SelectOption value={option[0]}>{option[1]}</SelectOption>
                            {/each}
                        </Select>
                    {:else if multilineFields.has(field)}
                        <Textarea
                            height="20"
                            bind:value={effect[field]}
                        />
                    {:else}
                        <Input
                            bind:value={effect[field]}
                        />
                    {/if}
                </div>
            </div>
        {/if}
    {/each}

</DisclosureList>
