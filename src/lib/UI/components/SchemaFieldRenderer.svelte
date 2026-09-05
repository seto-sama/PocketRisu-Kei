<script lang="ts">
    import type { ModelPreset, RegistryFieldSchema, RegistryUiField } from "src/ts/preset/types";
    import { language } from "src/lang";
    import { localizeDescription, localizeRegistryText } from "src/ts/preset/registry/i18n";
    import { XIcon } from "@lucide/svelte";
    import Input from "./Input.svelte";
    import SecretInput from "./SecretInput.svelte";
    import CredentialField from "src/lib/Setting/Pages/Model/CredentialField.svelte";
    import Textarea from "./Textarea.svelte";
    import NumberInput from "./NumberInput.svelte";
    import Slider from "./Slider.svelte";
    import Select from "./Select.svelte";
    import SelectOption from "./SelectOption.svelte";
    import Switch from "./Switch.svelte";

    interface Props {
        schemaField: RegistryFieldSchema;
        uiField: RegistryUiField;
        userValues: Record<string, unknown>;
        // Present only in the ModelPreset editor. Lets auth (`secret`) fields
        // render the saved-key picker, which binds the preset-level apiKeyRef.
        preset?: ModelPreset;
    }

    let { schemaField, uiField, userValues = $bindable(), preset }: Props = $props();

    const fieldKey = $derived(schemaField.key);
    const isAuthField = $derived(schemaField.mapsTo?.target === 'auth');

    // Reset (clear-to-undefined) is offered for optional scalar widgets where
    // a value is present. textarea/string-array/json/key-value let the user
    // clear by emptying the textarea directly, so we skip the button there.
    const resetableWidgets = new Set([
        'text', 'secret', 'number-input', 'slider',
        'select', 'segmented', 'combobox',
    ]);
    const compactRowWidgets = new Set([
        'text', 'secret', 'number-input',
        'select', 'segmented', 'combobox',
    ]);
    const showReset = $derived(
        !schemaField.required &&
        userValues[fieldKey] !== undefined &&
        resetableWidgets.has(uiField.widget)
    );

    function resetField() {
        userValues[fieldKey] = undefined;
    }

    function languageString(source: object, key?: string): string | undefined {
        if (!key) return undefined;
        const value = (source as Record<string, unknown>)[key];
        return typeof value === 'string' ? value : undefined;
    }

    // Bundled profiles may point at the same language/help entries used by the
    // regular settings pages. Literal registry text remains the fallback so
    // remote and user-authored profiles need no app-specific language keys.
    const localizedLabel = $derived(
        languageString(language, schemaField.labelKey)
            ?? localizeRegistryText(schemaField.label, schemaField.labelI18n)
    );
    const localizedDescription = $derived(
        languageString(language.help, schemaField.helpKey) ?? localizeDescription(schemaField)
    );
    const sliderMin = $derived(schemaField.min ?? 0);
    const sliderStep = $derived(schemaField.step ?? 1);
    const sliderEnabled = $derived(
        typeof userValues[fieldKey] === 'number'
        && Number.isFinite(userValues[fieldKey] as number)
    );

    function readDisableableSlider(): number {
        const value = userValues[fieldKey];
        return typeof value === 'number' && Number.isFinite(value) ? value : sliderMin;
    }

    function writeDisableableSlider(value: number) {
        userValues[fieldKey] = value < sliderMin ? undefined : value;
    }

    function setSliderEnabled(enabled: boolean) {
        const defaultValue = schemaField.default;
        const enabledValue = typeof defaultValue === 'number' && Number.isFinite(defaultValue)
            ? defaultValue
            : sliderMin;
        userValues[fieldKey] = enabled ? enabledValue : undefined;
    }

    // stringArray widget: textarea one-per-line, syncs to/from userValues[key]: string[]
    let stringArrayText = $state('');
    let stringArrayInitialized = $state(false);

    $effect(() => {
        if (uiField.widget !== 'string-array') return;
        if (stringArrayInitialized) return;
        const v = userValues[fieldKey];
        stringArrayText = Array.isArray(v) ? v.join('\n') : '';
        stringArrayInitialized = true;
    });

    $effect(() => {
        if (uiField.widget !== 'string-array') return;
        if (!stringArrayInitialized) return;
        const lines = stringArrayText.split('\n').map(s => s.trim()).filter(Boolean);
        userValues[fieldKey] = lines.length === 0 ? undefined : lines;
    });

    // combobox widget: a free-text input (the source of truth) plus a
    // suggestions dropdown that writes the picked value into it. Replaces the
    // native <datalist>, whose rendering is delegated to the browser and
    // misbehaves on mobile (suggestion taps not committing, crashes on Samsung
    // Internet). The dropdown reuses Select, so touch devices fall back to
    // the OS-native picker. Suggestions display the raw value (the model id),
    // not a prettified label, so what you pick is exactly what's sent — and the
    // pretty label never hides a "-preview"/date suffix.
    const comboOptions = $derived(
        uiField.widget === 'combobox'
            ? (schemaField.enum ?? []).filter(Boolean).map(o => String(o.value))
            : []
    );
    // The dropdown mirrors the text value only when it matches a suggestion;
    // otherwise it rests on the placeholder. userValues stays the single source
    // of truth — the dropdown never carries independent state that could desync.
    let comboPick = $state('');
    $effect(() => {
        if (uiField.widget !== 'combobox') return;
        const current = String(userValues[fieldKey] ?? '');
        comboPick = comboOptions.includes(current) ? current : '';
    });
    function comboSelect(picked: string) {
        // Ignore the placeholder ("") — clearing is done via the text field /
        // reset button, never by re-selecting the "choose a suggestion" row.
        if (picked) userValues[fieldKey] = picked;
    }

    // JSON widget: stringify on read, parse on write. Errors surface inline.
    // We seed jsonText from userValues once on mount, then user edits jsonText
    // and an $effect parses+commits on every change (invalid JSON keeps the
    // last good value but shows the error).
    let jsonText = $state('');
    let jsonError = $state<string | null>(null);
    let jsonInitialized = $state(false);

    $effect(() => {
        if (uiField.widget !== 'json' && uiField.widget !== 'key-value') return;
        if (jsonInitialized) return;
        const v = userValues[fieldKey];
        try {
            jsonText = v === undefined || v === null ? '' : JSON.stringify(v, null, 2);
        } catch {
            jsonText = '';
        }
        jsonInitialized = true;
    });

    $effect(() => {
        if (uiField.widget !== 'json' && uiField.widget !== 'key-value') return;
        if (!jsonInitialized) return;
        if (jsonText.trim() === '') {
            userValues[fieldKey] = undefined;
            jsonError = null;
            return;
        }
        try {
            userValues[fieldKey] = JSON.parse(jsonText);
            jsonError = null;
        } catch (e) {
            jsonError = e instanceof Error ? e.message : String(e);
        }
    });
</script>

{#if isAuthField && preset}
    <CredentialField {preset} {schemaField} {uiField} bind:userValues />
{:else if uiField.widget === 'toggle'}
    <!-- Registry boolean fields use the same shadcn switch-row grammar as the
         rest of the new settings UI. This is especially important for dense
         capability/compatibility groups such as Developer > Custom Flags. -->
    <div class="flex items-center justify-between gap-3 py-3 border-t border-darkborderc">
        <div class="flex flex-col min-w-0">
            <span class="text-sm text-maintext">
                {localizedLabel}
                {#if schemaField.required}<span class="text-danger">*</span>{/if}
            </span>
            {#if localizedDescription}
                <span class="text-xs text-subtext mt-0.5">{localizedDescription}</span>
            {/if}
        </div>
        <Switch
            checked={userValues[fieldKey] === true}
            ariaLabel={localizedLabel}
            onCheckedChange={(checked) => { userValues[fieldKey] = checked }}
        />
    </div>
{:else if uiField.widget === 'slider' && uiField.layout === 'row'}
    <!-- Same compact row grammar used by Settings → Prompt → General →
         Parameters: label/help on the left, fixed-width Slider + numeric
         input on the right. -->
    <div class="flex items-center justify-between gap-3 py-3 border-t border-darkborderc">
        <div class="flex flex-col min-w-0">
            <span class="text-sm text-maintext">
                {localizedLabel}
                {#if schemaField.required}<span class="text-danger">*</span>{/if}
            </span>
            {#if localizedDescription}
                <span class="text-xs text-subtext mt-0.5">{localizedDescription}</span>
            {/if}
        </div>
        <div class="flex shrink-0 items-center">
            {#if !uiField.disableable || sliderEnabled}
                <div class="w-48">
                    {#if uiField.disableable}
                        <Slider
                            bind:value={readDisableableSlider, writeDisableableSlider}
                            min={sliderMin - sliderStep}
                            max={schemaField.max ?? 100}
                            step={sliderStep}
                            fixed={uiField.fixed}
                            inputWidth="w-16"
                            placeholder={uiField.placeholder}
                        />
                    {:else}
                        <Slider
                            bind:value={userValues[fieldKey] as number}
                            min={sliderMin}
                            max={schemaField.max ?? 100}
                            step={sliderStep}
                            fixed={uiField.fixed}
                            inputWidth="w-16"
                            placeholder={uiField.placeholder}
                        />
                    {/if}
                </div>
            {:else}
                <Switch
                    checked={false}
                    ariaLabel={localizedLabel}
                    onCheckedChange={setSliderEnabled}
                />
            {/if}
        </div>
    </div>
{:else if uiField.layout === 'row' && (uiField.widget === 'textarea' || uiField.widget === 'string-array')}
    <!-- Multiline controls keep the row section grammar (divider, compact
         label/help) while stacking the editor below. Textarea's default
         height/size follows Sound & Display → textarea size settings. -->
    <div class="py-3 border-t border-darkborderc">
        <span class="text-sm text-maintext">
            {localizedLabel}
            {#if schemaField.required}<span class="text-danger">*</span>{/if}
        </span>
        {#if localizedDescription}
            <p class="text-xs text-subtext mt-0.5">{localizedDescription}</p>
        {/if}
        {#if uiField.widget === 'textarea'}
            <Textarea
                commitMode="debounce"
                className="mt-2"
                bind:value={userValues[fieldKey] as string}
                placeholder={uiField.placeholder ?? ''}
                popupTitle={localizedLabel}
                fullwidth
                autocomplete="off"
                height="default"
            />
        {:else}
            <Textarea
                commitMode="debounce"
                className="mt-2"
                bind:value={stringArrayText}
                placeholder={uiField.placeholder ?? ''}
                popupTitle={localizedLabel}
                fullwidth
                autocomplete="off"
                height="default"
            />
        {/if}
    </div>
{:else if uiField.layout === 'row' && compactRowWidgets.has(uiField.widget)}
    <!-- Compact setting row shared by the regular settings pages: descriptive
         copy on the left, a fixed w-48 small control on the right. -->
    <div class="flex items-center justify-between gap-3 py-3 border-t border-darkborderc">
        <div class="flex flex-col min-w-0">
            <span class="text-sm text-maintext">
                {localizedLabel}
                {#if schemaField.required}<span class="text-danger">*</span>{/if}
            </span>
            {#if localizedDescription}
                <span class="text-xs text-subtext mt-0.5">{localizedDescription}</span>
            {/if}
        </div>
        <div class="w-48 shrink-0">
            {#if uiField.widget === 'text'}
                <Input
                    commitMode="blur"
                    className="h-8 w-48 text-sm"
                    size="sm"
                    bind:value={userValues[fieldKey] as string}
                    placeholder={uiField.placeholder ?? ''}
                />
            {:else if uiField.widget === 'secret'}
                <SecretInput
                    className="h-8 px-2.5 py-0 text-sm"
                    bind:value={userValues[fieldKey] as string}
                    placeholder={uiField.placeholder ?? ''}
                    fullwidth
                />
            {:else if uiField.widget === 'number-input'}
                <NumberInput
                    className="w-48 text-sm"
                    size="sm"
                    bind:value={userValues[fieldKey] as number}
                    min={schemaField.min}
                    max={schemaField.max}
                />
            {:else if uiField.widget === 'select' || uiField.widget === 'segmented'}
                <Select className="w-48" size="sm" bind:value={userValues[fieldKey] as string}>
                    {#if !schemaField.required}
                        <SelectOption value="">{language.disabled}</SelectOption>
                    {/if}
                    {#each (schemaField.enum ?? []).filter(Boolean) as opt}
                        <SelectOption value={String(opt.value)}>{opt.label}</SelectOption>
                    {/each}
                </Select>
            {:else if uiField.widget === 'combobox'}
                <Input
                    commitMode="blur"
                    className="h-8 w-48 text-sm"
                    size="sm"
                    bind:value={userValues[fieldKey] as string}
                    placeholder={uiField.placeholder ?? ''}
                />
                {#if comboOptions.length > 0}
                    <Select
                        className="w-48 mt-1"
                        size="sm"
                        bind:value={comboPick}
                        onchange={(e) => comboSelect(String(e.currentTarget.value))}
                    >
                        <SelectOption value="">{language.modelPresetPickSuggestion}</SelectOption>
                        {#each comboOptions as opt}
                            <SelectOption value={opt}>{opt}</SelectOption>
                        {/each}
                    </Select>
                {/if}
            {/if}
        </div>
    </div>
{:else}
<div class="flex flex-col gap-1">
    <div class="flex items-center justify-between gap-2">
        <span class="text-sm text-maintext flex items-center gap-1">
            {localizedLabel}
            {#if schemaField.required}<span class="text-danger">*</span>{/if}
        </span>
        {#if showReset}
            <button
                type="button"
                class="text-subtext risu-interactive-danger transition-colors flex items-center gap-1 text-xs"
                title={language.reset}
                onclick={resetField}
            >
                <XIcon size={12} />
                <span>{language.reset}</span>
            </button>
        {/if}
    </div>
    {#if localizedDescription}
        <span class="text-xs text-subtext">{localizedDescription}</span>
    {/if}

    {#if uiField.widget === 'text'}
        <Input
            commitMode="blur"
            bind:value={userValues[fieldKey] as string}
            placeholder={uiField.placeholder ?? ''}
            fullwidth
        />
    {:else if uiField.widget === 'secret'}
        <SecretInput
            bind:value={userValues[fieldKey] as string}
            placeholder={uiField.placeholder ?? ''}
            fullwidth
        />
    {:else if uiField.widget === 'textarea'}
        <Textarea
            commitMode="debounce"
            bind:value={userValues[fieldKey] as string}
            placeholder={uiField.placeholder ?? ''}
            popupTitle={localizedLabel}
            fullwidth
            autocomplete="off"
            height="24"
        />
    {:else if uiField.widget === 'number-input'}
        <NumberInput
            bind:value={userValues[fieldKey] as number}
            min={schemaField.min}
            max={schemaField.max}
            fullwidth
        />
    {:else if uiField.widget === 'slider'}
        <Slider
            bind:value={userValues[fieldKey] as number}
            min={schemaField.min ?? 0}
            max={schemaField.max ?? 100}
            step={schemaField.step ?? 1}
            fixed={uiField.fixed}
            placeholder={uiField.placeholder}
        />
    {:else if uiField.widget === 'select'}
        <Select bind:value={userValues[fieldKey] as string}>
            {#each (schemaField.enum ?? []).filter(Boolean) as opt}
                <SelectOption value={String(opt.value)}>{opt.label}</SelectOption>
            {/each}
        </Select>
    {:else if uiField.widget === 'segmented'}
        <Select bind:value={userValues[fieldKey] as string}>
            {#each (schemaField.enum ?? []).filter(Boolean) as opt}
                <SelectOption value={String(opt.value)}>{opt.label}</SelectOption>
            {/each}
        </Select>
    {:else if uiField.widget === 'combobox'}
        <input
            type="text"
            class="risu-field-border bg-darkbg rounded-md px-2.5 py-2 text-maintext"
            bind:value={userValues[fieldKey] as string}
            placeholder={uiField.placeholder ?? ''}
        />
        {#if comboOptions.length > 0}
            <Select bind:value={comboPick} onchange={(e) => comboSelect(e.currentTarget.value)}>
                <SelectOption value="">{language.modelPresetPickSuggestion}</SelectOption>
                {#each comboOptions as opt}
                    <SelectOption value={opt}>{opt}</SelectOption>
                {/each}
            </Select>
        {/if}
    {:else if uiField.widget === 'string-array'}
        <Textarea
            commitMode="debounce"
            bind:value={stringArrayText}
            placeholder={uiField.placeholder ?? ''}
            popupTitle={localizedLabel}
            fullwidth
            autocomplete="off"
            height="default"
        />
    {:else if uiField.widget === 'json' || uiField.widget === 'key-value'}
        <Textarea
            commitMode="debounce"
            bind:value={jsonText}
            placeholder={uiField.placeholder ?? '{}'}
            popupTitle={localizedLabel}
            fullwidth
            autocomplete="off"
            height="32"
        />
        {#if jsonError}
            <span class="text-xs text-danger">{jsonError}</span>
        {/if}
    {/if}
</div>
{/if}
