<script lang="ts">
    import { Buffer } from 'buffer'
    import EmptyState from "src/lib/UI/components/EmptyState.svelte";
    import { alertGenerationInfoStore } from "../../ts/alert";
    
    import { DBState } from 'src/ts/stores.svelte';
    import { ParseMarkdown } from '../../ts/parser/parser.svelte';
    import { ChevronRightIcon } from '@lucide/svelte';
    import { isCharacterHasAssets } from 'src/ts/characterCards';
    import Input from '../UI/components/Input.svelte';
    import { openURL, downloadFile } from 'src/ts/globalApi.svelte';
    import Button from '../UI/components/Button.svelte';
    import Dialog from '../UI/components/Dialog.svelte';
    import AlertDialog from '../UI/components/AlertDialog.svelte';
    import LoadingDialog from '../UI/components/LoadingDialog.svelte';
    import { XIcon, ChevronDownIcon, ChevronUpIcon, CopyIcon, CheckIcon, TrashIcon, EllipsisVerticalIcon, RefreshCwIcon, PlusIcon, DownloadIcon, UploadIcon } from "@lucide/svelte";
    import Select from "../UI/components/Select.svelte";
    import SelectOption from "../UI/components/SelectOption.svelte";
    import { language } from 'src/lang';
    import { alertStore, selectedCharID, togglePresetsOpenStore } from "src/ts/stores.svelte";
    import Switch from "../UI/components/Switch.svelte";
    import * as DropdownMenu from '../UI/components/dropdown-menu';
    import { pocketKeiVer } from "src/ts/storage/database.svelte";
    import Textarea from "../UI/components/Textarea.svelte";
    import ModuleChatMenu from "../Setting/Pages/Module/ModuleChatMenu.svelte";
    import IconButton from "../UI/components/IconButton.svelte";
    import IconButtonGroup from "../UI/components/IconButtonGroup.svelte";
    import Help from "./Help.svelte";
    import { getCurrentCharacter, type TogglePreset, applyToggleValues, snapshotCurrentToggleValues } from "src/ts/storage/database.svelte";
    import { alertInput, alertConfirm, alertError, alertNormalWait, notifySuccess } from "src/ts/alert";
    import { selectSingleImportFile } from "src/ts/util";
    import { translateStackTrace } from "../../ts/sourcemap";
    import { getDetailedOSLabel, getFallbackOSLabel, getRisuEnvironmentLabel } from "src/ts/platform";
    import { PRODUCT_NAME } from "src/ts/branding";
    import RequestDiagnosticsModal from "./RequestDiagnosticsModal.svelte";
    import { overlayLayer } from 'src/ts/gui/overlayStack';
    import InlineEditableName from "../UI/components/InlineEditableName.svelte";
    import InlineRenameAction from "../UI/components/InlineRenameAction.svelte";
    import { InlineEditableNameController } from "../UI/components/InlineEditableNameController.svelte";

    let showDetails = $state(false);
    let translatedStackTrace = $state('');
    let stackTraceTranslationFailed = $state(false);
    let isTranslating = $state(false);
    let osLabel = $state(getFallbackOSLabel());
    const displayedStackTrace = $derived(translatedStackTrace || $alertStore.stackTrace || '');
    const risuEnvironment = getRisuEnvironmentLabel();
    const userAgent = typeof navigator === "undefined" ? "Unknown" : navigator.userAgent || "Unknown";
    const stackTraceCodeBlock = $derived.by(() => {
        const lines = [
            `${PRODUCT_NAME} v${pocketKeiVer}`,
            `OS: ${osLabel}`,
            `User-Agent: ${userAgent}`,
            `Risu environment: ${risuEnvironment}`,
        ]

        if (stackTraceTranslationFailed) {
            lines.push(language.stackTraceTranslationFailed)
        } else if (isTranslating) {
            lines.push(language.translating)
        }

        if (displayedStackTrace) {
            lines.push('', displayedStackTrace)
        }

        return lines.join('\n')
    });

    let btn
    let input = $state('')
    let cardExportType = $state('realm')
    let cardExportType2 = $state('')
    let cardLicense = $state('')
    let copiedKey: string | null = $state(null)
    let togglePresetShowAll = $state(false)
    let suppressInputFocusRestore = false

    function closeTogglePresets() {
        togglePresetsOpenStore.set(false)
    }

    async function applyTogglePreset(preset: TogglePreset) {
        const name = preset.name
        const currentPromptPresetName = DBState.db.botPresets[DBState.db.botPresetsId]?.name
        const isMismatch = preset.promptPresetName !== currentPromptPresetName
        const msg = isMismatch ? language.togglePresetMismatchConfirm : language.togglePresetApplyConfirm
        const confirmed = await alertConfirm(msg)
        if (!confirmed) return
        applyToggleValues(preset.values)
        notifySuccess((language.togglePresetApplied as any)(name))
        closeTogglePresets()
    }

    function renameTogglePreset(index: number, value: string) {
        const name = value.trim()
        const preset = DBState.db.togglePresets?.[index]
        if (!name || !preset || name === preset.name) return
        const oldName = preset.name
        preset.name = name
        DBState.db.togglePresets = [...DBState.db.togglePresets!]
        notifySuccess((language.togglePresetRenamed as any)(oldName, name))
    }

    function submitAlertInput(restoreFocus = true) {
        suppressInputFocusRestore = !restoreFocus
        alertStore.set({ type: 'none', msg: input })
    }

    function cancelCardExport() {
        alertStore.set({
            type: 'none',
            msg: JSON.stringify({
                type: 'cancel',
                type2: cardExportType2,
            }),
        })
    }

    async function copyToClipboard(text: string, key: string) {
        try {
            await navigator.clipboard.writeText(text)
        } catch {
            // fallback
            const textarea = document.createElement('textarea')
            textarea.value = text
            document.body.appendChild(textarea)
            textarea.select()
            document.execCommand('copy')
            document.body.removeChild(textarea)
        }
        copiedKey = key
        setTimeout(() => {
            if (copiedKey === key) copiedKey = null
        }, 1500)
    }
    $effect.pre(() => {
        showDetails = false;
        translatedStackTrace = '';
        stackTraceTranslationFailed = false;
        isTranslating = false;
        if(btn){
            btn.focus()
        }
        if($alertStore.type !== 'input'){
            input = ''
        } else {
            input = $alertStore.defaultValue ?? ''
        }
        if($alertStore.type !== 'cardexport'){
            cardExportType = ''
            cardExportType2 = ''
            cardLicense = ''
        }
    });

    $effect(() => {
        if ($alertStore.type === 'error' && $alertStore.stackTrace && !translatedStackTrace && !stackTraceTranslationFailed && !isTranslating) {
            void loadTranslatedTrace();
        }
    });

    $effect(() => {
        void loadDetailedOSLabel();
    });

    async function loadDetailedOSLabel() {
        try {
            osLabel = await getDetailedOSLabel();
        } catch (error) {
            console.warn("Failed to load detailed OS information:", error);
        }
    }

    async function loadTranslatedTrace() {
        if (isTranslating || translatedStackTrace || stackTraceTranslationFailed || !$alertStore.stackTrace) return;
        isTranslating = true;
        try {
            const result = await translateStackTrace($alertStore.stackTrace);
            if (result.didTranslate) {
                translatedStackTrace = result.stackTrace;
            } else {
                stackTraceTranslationFailed = true;
            }
        } catch (e) {
            console.error("Failed to translate stack trace:", e);
            stackTraceTranslationFailed = true;
        } finally {
            isTranslating = false;
        }
    }

</script>

<RequestDiagnosticsModal
    open={$alertStore.type === 'requestdata'}
    info={$alertGenerationInfoStore}
    onOpenChange={(open) => {
        if (!open && $alertStore.type === 'requestdata') {
            alertStore.set({ type: 'none', msg: '' })
        }
    }}
/>

{#if $alertStore.type === 'cardexport'}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div use:overlayLayer class="risu-modal-backdrop risu-layer-overlay flex flex-col items-center justify-center" role="button" tabindex="0" onclick={cancelCardExport}>
        <div class="bg-darkbg rounded-md p-4 max-w-full flex flex-col w-2xl" role="button" tabindex="0" onclick={(e) => {
            e.stopPropagation()
        }}>
            <h1 class="font-bold text-2xl w-full">
                <span>
                    {language.shareExport}
                </span>
                <IconButton size="lg" className="float-right" onclick={cancelCardExport}>
                    <XIcon />
                </IconButton>
            </h1>
            <span class="text-maintext mt-4">{language.type}</span>
            {#if cardExportType === ''}
                {#if $alertStore.submsg === 'preset'}
                    {#if cardExportType2 === 'preset' && (DBState.db.botPresets[DBState.db.botPresetsId].image || DBState.db.botPresets[DBState.db.botPresetsId].regex?.length > 0)}
                        <span class="text-danger text-sm">Use RisuRealm to share the preset. Preset with image or regexes cannot be exported for now.</span>
                    {/if}
                {:else if $alertStore.submsg !== 'module'}
                    <span class="text-subtext text-sm">{language.ccv3Desc}</span>
                    {#if cardExportType2 !== 'charx' && cardExportType2 !== 'charxJpeg' && isCharacterHasAssets(DBState.db.characters[$selectedCharID])}
                        <span class="text-danger text-sm">{language.notCharxWarn}</span>
                    {/if}
                {/if}
            {:else if cardExportType === 'json'}
                <span class="text-subtext text-sm">{language.jsonDesc}</span>
            {:else if cardExportType === 'ccv2'}
                <span class="text-subtext text-sm">{language.ccv2Desc}</span>
                <span class="text-danger text-sm">{language.v2Warning}</span>
            {/if}
            <div class="flex items-center flex-wrap mt-2">
                {#if $alertStore.submsg === 'preset'}
                    <Button variant={cardExportType === '' ? 'primary' : 'outline'} className="h-auto min-h-14 flex-1 px-2 py-4 {cardExportType === '' ? '' : 'text-subtext'}" aria-pressed={cardExportType === ''} onclick={() => {cardExportType = ''}}>Risupreset</Button>
                {:else if $alertStore.submsg === 'module'}
                    <Button variant={cardExportType === '' ? 'primary' : 'outline'} className="h-auto min-h-14 flex-1 px-2 py-4 {cardExportType === '' ? '' : 'text-subtext'}" aria-pressed={cardExportType === ''} onclick={() => {cardExportType = ''}}>RisuM</Button>
                {:else}
                    <Button variant={cardExportType === '' ? 'primary' : 'outline'} className="h-auto min-h-14 flex-1 px-2 py-4 {cardExportType === '' ? '' : 'text-subtext'}" aria-pressed={cardExportType === ''} onclick={() => {
                        cardExportType = ''
                        cardExportType2 = 'charxJpeg'
                    }}>Character Card V3</Button>
                    <Button variant={cardExportType === 'ccv2' ? 'primary' : 'outline'} className="ml-2 h-auto min-h-14 flex-1 px-2 py-4 {cardExportType === 'ccv2' ? '' : 'text-subtext'}" aria-pressed={cardExportType === 'ccv2'} onclick={() => {cardExportType = 'ccv2'}}>Character Card V2</Button>
                {/if}
            </div>
            {#if $alertStore.submsg === '' && cardExportType === ''}
                <span class="text-maintext mt-4">{language.format}</span>
                <Select bind:value={cardExportType2} className="mt-2">
                    <SelectOption value="charx">CHARX</SelectOption>
                    <SelectOption value="charxJpeg">CHARX-JPEG</SelectOption>
                    <SelectOption value="">PNG</SelectOption>
                    <SelectOption value="json">JSON</SelectOption>
                </Select>
                <div class="mt-4 flex items-center justify-between gap-4">
                    <div class="flex min-w-0 flex-col">
                        <span class="text-maintext">{language.imageCompression}</span>
                        <span class="text-subtext text-sm">{language.help.imageCompression}</span>
                    </div>
                    <Switch className="shrink-0" bind:checked={DBState.db.imageCompression} />
                </div>
            {/if}
            <Button className="mt-4" onclick={() => {
                alertStore.set({
                    type: 'none',
                    msg: JSON.stringify({
                        type: cardExportType,
                        type2: cardExportType2
                    })
                })
            }}>{language.export}</Button>
        </div>
    </div>

{:else if $alertStore.type === 'selectModule'}
    <ModuleChatMenu alertMode close={(d) => {
        alertStore.set({
            type: 'none',
            msg: d
        })
    }} />
{/if}

<Dialog
    open={$alertStore.type === 'addchar'}
    size="lg"
    closeOnEscape={true}
    onOpenChange={(v) => {
        if (!v && $alertStore.type === 'addchar') {
            alertStore.set({ type: 'none', msg: 'cancel' })
        }
    }}
>
    {#snippet title()}
        {language.addCharacter}
    {/snippet}

    <div class="flex flex-col gap-2">
        <button
            class="add-character-option add-character-option-featured"
            onclick={() => alertStore.set({ type: 'none', msg: 'importFromRealm' })}
        >
            <span class="flex min-w-0 flex-col items-start text-left">
                <span class="text-xl font-bold">{language.importFromRealm}</span>
                <span class="text-sm text-subtext">{language.importFromRealmDesc}</span>
            </span>
            <ChevronRightIcon size={20} />
        </button>

        <button
            class="add-character-option"
            onclick={() => alertStore.set({ type: 'none', msg: 'importCharacter' })}
        >
            <span>{language.importCharacterAndPackage}</span>
            <ChevronRightIcon size={18} />
        </button>

        <button
            class="add-character-option"
            onclick={() => alertStore.set({ type: 'none', msg: 'createfromScratch' })}
        >
            <span>{language.createfromScratch}</span>
            <ChevronRightIcon size={18} />
        </button>

    </div>
</Dialog>

<Dialog
    open={$alertStore.type === 'error'}
    size="lg"
    onOpenChange={(v) => {
        if (!v && $alertStore.type === 'error') {
            alertStore.set({ type: 'none', msg: '' })
        }
    }}
>
    {#snippet title()}
        <span class="text-danger">{language.error}</span>
    {/snippet}

    <div class="flex flex-col gap-2">
        <span class="text-maintext whitespace-pre-wrap wrap-break-word">{$alertStore.msg}</span>
        {#if $alertStore.submsg}
            <span class="text-subtext text-sm">{$alertStore.submsg}</span>
        {/if}

        {#if $alertStore.stackTrace}
            <div class="mt-2">
                <Button variant="outline" size="sm" onclick={() => showDetails = !showDetails}>
                    {showDetails ? language.hideErrorDetails : language.showErrorDetails}
                    {#if showDetails}
                        <XIcon class="inline ml-2" />
                    {:else}
                        <ChevronRightIcon class="inline ml-2" />
                    {/if}
                </Button>
                {#if showDetails}
                    <div class="stack-trace-wrap">
                        <button
                            class="stack-trace-copy"
                            onclick={() => copyToClipboard(stackTraceCodeBlock, 'stack-trace')}
                            title={language.copy}
                            aria-label={language.copy}
                        >
                            {#if copiedKey === 'stack-trace'}
                                <CheckIcon size={12} />
                            {:else}
                                <CopyIcon size={12} />
                            {/if}
                        </button>
                        <pre class="stack-trace">{stackTraceCodeBlock}</pre>
                    </div>
                {/if}
            </div>
        {/if}
    </div>

    {#snippet footer()}
        <Button onclick={() => alertStore.set({ type: 'none', msg: '' })}>{language.confirm}</Button>
    {/snippet}
</Dialog>

<Dialog
    open={$alertStore.type === 'normal'}
    onOpenChange={(v) => {
        if (!v && $alertStore.type === 'normal') {
            alertStore.set({ type: 'none', msg: '' })
        }
    }}
>
    <div class="flex flex-col gap-2">
        <span class="whitespace-pre-wrap">{$alertStore.msg}</span>
        {#if $alertStore.submsg}
            <span class="text-subtext text-sm">{$alertStore.submsg}</span>
        {/if}
    </div>

    {#snippet footer()}
        <Button onclick={() => alertStore.set({ type: 'none', msg: '' })}>{language.confirm}</Button>
    {/snippet}
</Dialog>

{#snippet markdownFooter()}
    <Button onclick={() => alertStore.set({ type: 'none', msg: '' })}>{language.confirm}</Button>
{/snippet}

<Dialog
    open={$alertStore.type === 'markdown'}
    size="lg"
    footer={$alertStore.hideConfirm ? undefined : markdownFooter}
    onOpenChange={(v) => {
        if (!v && $alertStore.type === 'markdown') {
            alertStore.set({ type: 'none', msg: '' })
        }
    }}
>
    <div class="overflow-y-auto">
        <span class="chattext prose chattext2">
            {#await ParseMarkdown($alertStore.msg) then msg}
                {@html msg}
            {/await}
        </span>
    </div>

</Dialog>

<AlertDialog
    open={$alertStore.type === 'ask'}
    closeOnEscape={true}
    closeOnOutsideClick={true}
    onCancel={() => alertStore.set({ type: 'none', msg: 'no' })}
    onConfirm={() => alertStore.set({ type: 'none', msg: 'yes' })}
    onOpenChange={(v) => {
        if (!v && $alertStore.type === 'ask') {
            alertStore.set({ type: 'none', msg: 'no' })
        }
    }}
>
    <div class="flex flex-col gap-2">
        <span class="whitespace-pre-wrap text-maintext">{$alertStore.msg}</span>
        {#if $alertStore.submsg}
            <span class="whitespace-pre-wrap text-sm text-subtext">{$alertStore.submsg}</span>
        {/if}
    </div>
    {#snippet footer()}
        <Button variant="outline" onclick={() => alertStore.set({ type: 'none', msg: 'no' })}>{language.no}</Button>
        <Button onclick={() => alertStore.set({ type: 'none', msg: 'yes' })}>{language.yes}</Button>
    {/snippet}
</AlertDialog>

<AlertDialog
    open={$alertStore.type === 'pluginconfirm'}
    closeOnEscape={true}
    closeOnOutsideClick={true}
    onCancel={() => alertStore.set({ type: 'none', msg: 'no' })}
    onConfirm={() => alertStore.set({ type: 'none', msg: 'yes' })}
    onOpenChange={(v) => {
        if (!v && $alertStore.type === 'pluginconfirm') {
            alertStore.set({ type: 'none', msg: 'no' })
        }
    }}
>
    {#if $alertStore.type === 'pluginconfirm'}
        {@const parts = $alertStore.msg.split('\n\n')}
        {@const mainPart = parts[0] ?? ''}
        {@const confirmMessage = parts[1] ?? ''}
        {@const mainParts = mainPart.split('\n')}
        {@const pluginName = mainParts[0] ?? ''}
        {@const warnings = mainParts.slice(1)}
        <div class="flex flex-col gap-3">
            <p class="text-xl font-bold text-maintext">{pluginName}</p>
            {#if warnings.length > 0}
                <ul class="list-disc list-inside text-danger text-sm space-y-1">
                    {#each warnings as warning}
                        <li>{warning}</li>
                    {/each}
                </ul>
            {/if}
            {#if confirmMessage}
                <p class="text-subtext">{confirmMessage}</p>
            {/if}
        </div>
    {/if}
    {#snippet footer()}
        <Button variant="outline" onclick={() => alertStore.set({ type: 'none', msg: 'no' })}>{language.no}</Button>
        <Button variant="destructive" onclick={() => alertStore.set({ type: 'none', msg: 'yes' })}>{language.yes}</Button>
    {/snippet}
</AlertDialog>

<Dialog
    open={$alertStore.type === 'select'}
    closable={false}
    closeOnOutsideClick={$alertStore.closeOnOutsideClick ?? true}
    onOpenChange={(v) => {
        if (!v && $alertStore.type === 'select') {
            alertStore.set({ type: 'none', msg: '-1' })
        }
    }}
>
    {#if $alertStore.type === 'select'}
        {@const hasDisplay = $alertStore.msg.startsWith('__DISPLAY__')}
        {@const raw = hasDisplay ? $alertStore.msg.substring(11) : $alertStore.msg}
        {@const parts = raw.split('||')}
        {@const prompt = hasDisplay ? parts[0] : ''}
        {@const options = hasDisplay ? parts.slice(1) : parts}
        <div class="flex flex-col gap-3">
            {#if prompt}
                <p class="text-maintext whitespace-pre-wrap">{prompt}</p>
            {/if}
            <div class="flex flex-col gap-2">
                {#each options as label, i}
                    <Button
                        variant="outline"
                        className="w-full justify-start"
                        onclick={() => alertStore.set({ type: 'none', msg: i.toString() })}
                    >
                        {label}
                    </Button>
                {/each}
            </div>
        </div>
    {/if}
</Dialog>

<AlertDialog
    open={$alertStore.type === 'confirmMulti'}
    closeOnEscape={true}
    closeOnOutsideClick={true}
    onOpenChange={(v) => {
        if (!v && $alertStore.type === 'confirmMulti') {
            alertStore.set({ type: 'none', msg: 'cancel' })
        }
    }}
>
    {#snippet title()}
        {$alertStore.msg}
    {/snippet}
    {#if $alertStore.submsg}
        {#snippet description()}
            <span class="whitespace-pre-wrap">{$alertStore.submsg}</span>
        {/snippet}
    {/if}
    {#if $alertStore.type === 'confirmMulti'}
        {@const actions = $alertStore.actions ?? []}
        <div class="flex flex-col gap-2">
            {#each actions as action, i}
                <Button
                    variant={action.variant ?? 'default'}
                    className="w-full"
                    onclick={() => alertStore.set({ type: 'none', msg: i.toString() })}
                >
                    {action.label}
                </Button>
            {/each}
        </div>
    {/if}
    {#snippet footer()}
        <Button variant="outline" onclick={() => alertStore.set({ type: 'none', msg: 'cancel' })}>{language.cancel}</Button>
    {/snippet}
</AlertDialog>

<Dialog
    open={$alertStore.type === 'input'}
    closable={false}
    closeOnOutsideClick={false}
    onCloseAutoFocus={(event) => {
        if (suppressInputFocusRestore) event.preventDefault()
        suppressInputFocusRestore = false
    }}
>
    <div class="flex flex-col gap-3">
        {#if $alertStore.msg}
            <p class="text-maintext whitespace-pre-wrap">{$alertStore.msg}</p>
        {/if}
        <Input
            bind:value={input}
            id="alert-input"
            autocomplete="off"
            list="alert-input-list"
            fullwidth
            onkeydown={(e) => {
                if (e.key !== 'Enter') return
                e.stopPropagation()
                if (e.isComposing) {
                    const target = e.currentTarget as HTMLInputElement
                    setTimeout(() => {
                        input = target.value
                        submitAlertInput(false)
                    }, 0)
                    return
                }
                e.preventDefault()
                submitAlertInput(false)
            }}
        />
        {#if $alertStore.datalist}
            <datalist id="alert-input-list">
                {#each $alertStore.datalist as item}
                    <option
                        value={item[0]}
                        label={item[1] ? item[1] : item[0]}
                    >{item[1] ? item[1] : item[0]}</option>
                {/each}
            </datalist>
        {/if}
    </div>
    {#snippet footer()}
        <Button variant="outline" onclick={() => alertStore.set({ type: 'none', msg: '' })}>{language.cancel}</Button>
        <Button onclick={() => submitAlertInput()}>{language.confirm}</Button>
    {/snippet}
</Dialog>

<LoadingDialog
    open={$alertStore.type === 'wait' || $alertStore.type === 'wait2' || $alertStore.type === 'progress'}
    message={$alertStore.msg}
    submessage={$alertStore.type !== 'progress' ? ($alertStore.submsg ?? '') : ''}
    progress={$alertStore.type === 'progress' ? parseFloat($alertStore.submsg ?? '0') : null}
/>

<AlertDialog
    open={$alertStore.type === 'tos'}
    closeOnEscape={true}
    onCancel={() => alertStore.set({ type: 'none', msg: 'no' })}
    onConfirm={() => alertStore.set({ type: 'none', msg: 'yes' })}
    onOpenChange={(v) => {
        if (!v && $alertStore.type === 'tos') {
            alertStore.set({ type: 'none', msg: 'no' })
        }
    }}
>
    <!-- svelte-ignore a11y_missing_attribute -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="text-maintext">
        You should accept
        <a role="button" tabindex="0" class="text-lightborderc hover:underline cursor-pointer" onclick={() => openURL('https://sv.risuai.xyz/hub/tos')}>Terms of Service</a>
        to continue.
    </div>
    {#snippet footer()}
        <Button variant="outline" onclick={() => alertStore.set({ type: 'none', msg: 'no' })}>Do not Accept</Button>
        <Button onclick={() => alertStore.set({ type: 'none', msg: 'yes' })}>Accept</Button>
    {/snippet}
</AlertDialog>

<Dialog
    open={$togglePresetsOpenStore}
    onOpenChange={(v) => { if (!v) closeTogglePresets() }}
>
    {#snippet title()}{language.togglePresetSelectTitle}{/snippet}

    {#if $togglePresetsOpenStore}
        {@const currentPromptPresetName = DBState.db.botPresets[DBState.db.botPresetsId]?.name}
        <div class="flex flex-col gap-3">
            <label class="flex items-center gap-2 text-sm text-subtext self-start cursor-pointer select-none">
                <Switch bind:checked={togglePresetShowAll} />
                {language.togglePresetFilterShowAll}
            </label>

            {#if !DBState.db.togglePresets?.length}
                <EmptyState title={language.togglePresetEmpty} description="" layout="section" />
            {:else}
                {@const filteredPresets = togglePresetShowAll
                    ? DBState.db.togglePresets.map((p, i) => ({preset: p, index: i}))
                    : DBState.db.togglePresets.map((p, i) => ({preset: p, index: i})).filter(({preset}) => preset.promptPresetName === currentPromptPresetName)}
                {#if filteredPresets.length === 0}
                    <EmptyState layout="section" />
                {:else}
                    <div class="flex flex-col gap-1">
                        {#each filteredPresets as {preset, index: i}}
                            {@const renameController = new InlineEditableNameController()}
                            <div data-inline-rename-row class="flex items-center border border-darkborderc rounded-md hover:ring-1 hover:ring-lightborderc/50 transition-shadow">
                                <div
                                    role="button"
                                    tabindex="0"
                                    class="flex-1 min-w-0 p-2 text-left cursor-pointer text-maintext risu-interactive-surface rounded-l-md transition-colors"
                                    onclick={() => { void applyTogglePreset(preset) }}
                                    onkeydown={(event) => {
                                        if (event.key === 'Enter' || event.key === ' ') void applyTogglePreset(preset)
                                    }}
                                >
                                    <div class="text-xs text-subtext leading-tight">{preset.promptPresetName ?? language.togglePresetNoPromptPreset}</div>
                                    <InlineEditableName
                                        controller={renameController}
                                        value={preset.name}
                                        label={preset.name}
                                        onActivate={() => { void applyTogglePreset(preset) }}
                                        onCommit={(value) => renameTogglePreset(i, value)}
                                    />
                                </div>
                                <IconButtonGroup className="shrink-0 pr-1" onclick={(event) => event.stopPropagation()} onkeydown={(event) => event.stopPropagation()}>
                                    <InlineRenameAction controller={renameController} />
                                    {#if togglePresetShowAll}
                                        <IconButton onclick={() => {
                                            if (i > 0) {
                                                const presets = DBState.db.togglePresets!;
                                                [presets[i - 1], presets[i]] = [presets[i], presets[i - 1]];
                                                DBState.db.togglePresets = [...presets];
                                            }
                                        }}>
                                            <ChevronUpIcon />
                                        </IconButton>
                                        <IconButton onclick={() => {
                                            const presets = DBState.db.togglePresets!;
                                            if (i < presets.length - 1) {
                                                [presets[i], presets[i + 1]] = [presets[i + 1], presets[i]];
                                                DBState.db.togglePresets = [...presets];
                                            }
                                        }}>
                                            <ChevronDownIcon />
                                        </IconButton>
                                    {/if}
                                    <DropdownMenu.Root>
                                        <DropdownMenu.Trigger>
                                            {#snippet child({ props })}
                                                <IconButton {...props}>
                                                    <EllipsisVerticalIcon />
                                                </IconButton>
                                            {/snippet}
                                        </DropdownMenu.Trigger>
                                        <DropdownMenu.Content class="min-w-40" align="end">
                                            <DropdownMenu.Item onSelect={async () => {
                                                const idx = i
                                                const presetName = DBState.db.togglePresets![idx].name
                                                const confirmed = await alertConfirm((language.togglePresetOverwriteConfirm as any)(presetName))
                                                if (confirmed) {
                                                    const promptPreset = DBState.db.botPresets[DBState.db.botPresetsId]
                                                    DBState.db.togglePresets![idx].values = snapshotCurrentToggleValues()
                                                    DBState.db.togglePresets![idx].promptPresetName = promptPreset?.name
                                                    DBState.db.togglePresets = [...DBState.db.togglePresets!]
                                                    notifySuccess((language.togglePresetOverwritten as any)(presetName))
                                                }
                                            }}>
                                                <RefreshCwIcon size={12} />
                                                {language.togglePresetMenuOverwrite}
                                            </DropdownMenu.Item>
                                            <DropdownMenu.Item onSelect={() => {
                                                const copy = $state.snapshot(preset);
                                                copy.name = preset.name + ' (Copy)';
                                                DBState.db.togglePresets!.splice(i + 1, 0, copy);
                                                DBState.db.togglePresets = [...DBState.db.togglePresets!];
                                                notifySuccess((language.togglePresetDuplicated as any)(copy.name))
                                            }}>
                                                <CopyIcon size={12} />
                                                {language.togglePresetMenuDuplicate}
                                            </DropdownMenu.Item>
                                            <DropdownMenu.Item onSelect={() => {
                                                const exportData = { name: preset.name, values: preset.values, promptPresetName: preset.promptPresetName }
                                                downloadFile(`${preset.name}_toggle.json`, Buffer.from(JSON.stringify(exportData, null, 2), 'utf-8'))
                                                notifySuccess((language.togglePresetExported as any)(preset.name))
                                            }}>
                                                <DownloadIcon size={12} />
                                                {language.togglePresetMenuExport}
                                            </DropdownMenu.Item>
                                            <DropdownMenu.Separator />
                                            <DropdownMenu.Item variant="destructive" onSelect={async () => {
                                                const idx = i
                                                const presetName = DBState.db.togglePresets![idx].name
                                                const confirmed = await alertConfirm((language.togglePresetDeleteConfirm as any)(presetName))
                                                if (confirmed) {
                                                    DBState.db.togglePresets!.splice(idx, 1)
                                                    DBState.db.togglePresets = [...DBState.db.togglePresets!]
                                                    notifySuccess((language.togglePresetDeleted as any)(presetName))
                                                }
                                            }}>
                                                <TrashIcon size={12} />
                                                {language.togglePresetMenuDelete}
                                            </DropdownMenu.Item>
                                        </DropdownMenu.Content>
                                    </DropdownMenu.Root>
                                </IconButtonGroup>
                            </div>
                        {/each}
                    </div>
                {/if}
            {/if}

            <!-- Add new / import: live alongside the list rather than as a
                 dialog footer, since they create new entries instead of
                 closing the dialog. Mobile stacks vertically so the long
                 Korean labels don't wrap inside narrow flex-1 cells. -->
            <div class="flex flex-col sm:flex-row gap-2 mt-1">
                <Button
                    variant="outline"
                    className="w-full sm:flex-1 sm:w-auto"
                    onclick={async () => {
                        const name = await alertInput(language.togglePresetNamePrompt)
                        if (!name) return
                        DBState.db.togglePresets ??= []
                        const promptPreset = DBState.db.botPresets[DBState.db.botPresetsId]
                        DBState.db.togglePresets.push({
                            name,
                            values: snapshotCurrentToggleValues(),
                            promptPresetName: promptPreset?.name
                        })
                        DBState.db.togglePresets = [...DBState.db.togglePresets]
                        notifySuccess((language.togglePresetSaved as any)(name))
                    }}
                >
                    <PlusIcon />
                    {language.togglePresetSaveNew}
                </Button>
                <Button
                    variant="outline"
                    className="w-full sm:flex-1 sm:w-auto"
                    onclick={async () => {
                        let f: {name: string, data: Uint8Array} | undefined
                        try {
                            f = await selectSingleImportFile()
                        } catch { return }
                        if (!f) return
                        try {
                            const data = JSON.parse(Buffer.from(f.data).toString('utf-8'))
                            if (typeof data.name !== 'string' || !data.values || typeof data.values !== 'object' || Array.isArray(data.values)) {
                                alertError(language.togglePresetImportError)
                                return
                            }
                            const sanitizedValues: Record<string, string> = {}
                            for (const [k, v] of Object.entries(data.values)) {
                                if (typeof k === 'string' && typeof v === 'string') {
                                    sanitizedValues[k] = v
                                }
                            }
                            DBState.db.togglePresets ??= []
                            DBState.db.togglePresets.push({
                                name: data.name,
                                values: sanitizedValues,
                                promptPresetName: typeof data.promptPresetName === 'string' ? data.promptPresetName : undefined
                            })
                            DBState.db.togglePresets = [...DBState.db.togglePresets]
                            notifySuccess((language.togglePresetImported as any)(data.name))
                        } catch {
                            alertError(language.togglePresetImportError)
                        }
                    }}
                >
                    <UploadIcon />
                    {language.togglePresetImport}
                </Button>
            </div>
        </div>
    {/if}
</Dialog>

<style>
    .add-character-option {
        display: flex;
        width: 100%;
        min-height: 2.75rem;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        padding: 0.625rem 1rem;
        border: 1px solid var(--risu-theme-darkborderc);
        border-radius: 0.5rem;
        background-color: transparent;
        color: var(--risu-theme-maintext);
        transition:
            background-color 150ms ease,
            color 150ms ease;
    }

    .add-character-option:is(:hover, :focus-visible) {
        background-color: color-mix(in srgb, var(--risu-theme-selected) 30%, transparent);
    }

    .add-character-option :global(svg) {
        flex: none;
        color: var(--risu-theme-subtext);
        transition: color 150ms ease;
    }

    .add-character-option-featured {
        min-height: 6.5rem;
        padding: 1.25rem;
        background-color: color-mix(in srgb, var(--risu-theme-selected) 18%, transparent);
    }

    .stack-trace-wrap {
        position: relative;
        margin-top: 0.5rem;
    }

    .stack-trace {
        background-color: var(--risu-theme-lightbg);
        color: var(--risu-theme-subtext);
        border: 1px solid var(--risu-theme-darkborderc);
        border-radius: 0.25rem;
        padding: 0.75rem 2.75rem 0.75rem 0.75rem;
        font-family: monospace;
        font-size: 0.75rem;
        white-space: pre-wrap;
        word-break: break-all;
        max-height: 200px;
        overflow-y: auto;
    }

    .stack-trace-copy {
        position: absolute;
        top: 0.5rem;
        right: 0.5rem;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 1.75rem;
        height: 1.75rem;
        border: 1px solid var(--risu-theme-darkborderc);
        border-radius: 0.375rem;
        background-color: var(--risu-theme-darkbg);
        color: var(--risu-theme-subtext);
        transition: background-color 0.2s ease, color 0.2s ease, border-color 0.2s ease;
    }

    .stack-trace-copy:is(:hover, :focus-visible) {
        background-color: var(--risu-theme-lightbg);
        color: var(--risu-theme-maintext);
    }

</style>
