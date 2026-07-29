<script lang="ts">
    import { CopyIcon, DownloadIcon, RefreshCwIcon, Trash2Icon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { DBState, modelProfileReplaceTarget, openModelProfileBrowser, openModelPresetEditId } from "src/ts/stores.svelte";
    import { alertConfirm, notifySuccess } from "src/ts/alert";
    import { downloadFile } from "src/ts/globalApi.svelte";
    import { getOfficialRegistryId, getOfficialRegistry, isOfficialRegistryId } from "src/ts/preset/registry";
    import { buildFragmentFromSnapshot, getProfileUpdateStatus } from "src/ts/preset/customProfiles";
    import { replaceModelPresetProfile } from "src/ts/preset/profileUpdate";
    import { localizeDescription } from "src/ts/preset/registry/i18n";
    import { pluginProfileDisplayId } from "src/ts/preset/pluginModels";
    import { compileModelPreset } from "src/ts/preset/runtime/compilePreset";
    import type { ModelPreset } from "src/ts/preset/types";
    import type { SettingItem } from "src/ts/setting/types";
    import SettingRenderer from "src/lib/Setting/SettingRenderer.svelte";
    import SchemaFormRenderer from "src/lib/UI/GUI/SchemaFormRenderer.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import { v4 as uuidv4 } from "uuid";

    interface Props {
        preset: ModelPreset;
        onAfterDelete?: () => void;
    }

    let { preset = $bindable(), onAfterDelete = () => {} }: Props = $props();
    const compiled = $derived.by(() => {
        try {
            return compileModelPreset(preset);
        } catch {
            return undefined;
        }
    });
    const streamingAvailable = $derived(compiled?.availability.streaming === true);

    const basicInfoItems: SettingItem[] = [{
        id: 'modelPreset.name',
        type: 'text',
        labelKey: 'name',
        bindPath: 'name',
        options: { defaultValue: '' },
    }];

    const responseItems: SettingItem[] = [
        {
            id: 'modelPreset.streaming',
            type: 'check',
            labelKey: 'streamingOverride',
            helpKey: 'streamingOverrideHelp',
            bindPath: 'useStreaming',
        },
        {
            id: 'modelPreset.decoupledStreaming',
            type: 'check',
            labelKey: 'decoupledStreaming',
            helpKey: 'decoupledStreamingHelp',
            condition: () => !!preset.useStreaming,
            bindPath: 'decoupledStreaming',
        },
    ];
    const hasInfoFields = $derived(
        preset.profileSnapshot.uiSchema.fields.some(field => field?.visibility === 'info')
    );

    function duplicate() {
        const src = preset;
        const idx = DBState.db.modelPresets.findIndex(p => p.id === src.id);
        if (idx < 0) return;
        const copy = safeStructuredClone(src);
        copy.id = uuidv4();
        copy.name = `${src.name} Copy`;
        copy.createdAt = Date.now();
        copy.updatedAt = Date.now();
        DBState.db.modelPresets = [...DBState.db.modelPresets, copy];
        notifySuccess(language.presetDuplicated);
        // Jump straight into the new copy's editor (parent watches this store).
        openModelPresetEditId.set(copy.id);
    }

    async function remove() {
        const ok = await alertConfirm(`${language.presetDeleteConfirm}\n${preset.name}`);
        if (!ok) return;
        const idx = DBState.db.modelPresets.findIndex(p => p.id === preset.id);
        if (idx < 0) return;
        const next = [...DBState.db.modelPresets];
        next.splice(idx, 1);
        DBState.db.modelPresets = next;
        notifySuccess(language.presetDeleted);
        onAfterDelete();
    }

    // Resolve the preset's source profile in its registry (official=models.dev,
    // else the persisted custom cache) — drives the update hint, updated-at
    // date, and the one-click apply.
    const sourceLookup = $derived.by(() => {
        const sp = preset.sourceProfile;
        const cache = !sp?.registryId
            ? undefined
            : isOfficialRegistryId(sp.registryId)
                ? getOfficialRegistry()
                : DBState.db.modelProfileRegistryCache;
        const registryId = isOfficialRegistryId(sp?.registryId) ? getOfficialRegistryId() : sp?.registryId;
        const current = registryId ? cache?.registries?.[registryId]?.profiles?.[sp?.profileId ?? ''] : undefined;
        return { sp, cache, current, registryId };
    });
    // A self-contained/transient preset (notably plugin models) intentionally
    // has no source registry. Only show "source missing" when it once had a
    // source and that profile can no longer be resolved.
    const updateStatus = $derived(
        preset.sourceProfile
            ? getProfileUpdateStatus(sourceLookup.current, preset.sourceProfile.profileUpdatedAt)
            : 'none'
    );
    // Installed = the snapshot this preset is pinned to; latest = the registry's
    // current version (only meaningful when an update is available).
    const installedLabel = $derived(fmtDate(preset.sourceProfile?.profileUpdatedAt));
    const latestLabel = $derived(fmtDate(sourceLookup.current?.updatedAt));
    const description = $derived(sourceLookup.current ? localizeDescription(sourceLookup.current) : '');
    const modelReleaseDate = $derived(fmtMetadataDate(sourceLookup.current?.modelReleaseDate));
    const dataCutoff = $derived(fmtMetadataDate(sourceLookup.current?.knowledgeCutoff));
    const profileDisplayId = $derived(
        preset.profileSnapshot.adapterKind === 'plugin'
            ? pluginProfileDisplayId(preset.profileSnapshot.modelId)
            : preset.profileSnapshot.profileId
    );
    const showDefaultModel = $derived(
        !!preset.profileSnapshot.modelId
        && !(
            preset.profileSnapshot.adapterKind !== 'echo'
            && isOfficialRegistryId(preset.sourceProfile?.registryId)
        )
    );

    function fmtDate(ms?: number): string {
        // Strip the ko-locale trailing period ("2026. 6. 3." -> "2026. 6. 3").
        return ms ? new Date(ms).toLocaleDateString().replace(/\.\s*$/, '') : '';
    }

    function fmtMetadataDate(value?: string): string {
        const raw = value?.trim() ?? '';
        const match = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(raw);
        if (!match) return raw;

        const [, yearText, monthText, dayText] = match;
        const year = Number(yearText);
        const month = Number(monthText ?? 1);
        const day = Number(dayText ?? 1);
        const date = new Date(year, month - 1, day);
        if (
            date.getFullYear() !== year
            || date.getMonth() !== month - 1
            || date.getDate() !== day
        ) {
            return raw;
        }

        const options: Intl.DateTimeFormatOptions = { year: 'numeric' };
        if (monthText) options.month = 'numeric';
        if (dayText) options.day = 'numeric';
        return date.toLocaleDateString(undefined, options).replace(/\.\s*$/, '');
    }

    function replaceProfile() {
        modelProfileReplaceTarget.set(preset.id);
        openModelProfileBrowser.set(true);
    }

    // One-click apply of the current source profile (the "update available"
    // badge). Re-resolves the same profile, migrates compatible userValues, and
    // warns before moving incompatible settings out of the active form.
    async function applyUpdate() {
        const { sp, cache, current, registryId } = sourceLookup;
        if (!sp?.registryId || !cache || !current || !registryId) return;
        const result = replaceModelPresetProfile(preset, {
            registry: cache,
            registryId,
            profileId: sp.profileId,
        });
        if (!result) return;
        const warn = result.droppedKeys.length > 0 ? language.profileReplaceWarn : language.profileUpdateLossWarn;
        const msg = `${warn}\n\n`
            + `${language.profileUpdatedAtLabel}: ${fmtDate(sp.profileUpdatedAt) || '-'}\n`
            + `${language.profileLatestVersionLabel}: ${fmtDate(current.updatedAt) || '-'}`;
        if (!(await alertConfirm(msg))) return;
        Object.assign(preset, result.preset);
        notifySuccess(language.profileReplaced);
    }

    async function exportPreset() {
        const fragment = buildFragmentFromSnapshot(preset.profileSnapshot, preset.name, Date.now());
        const name = (preset.name || 'profile').replace(/[^a-z0-9._-]/gi, '_');
        await downloadFile(`${name}.profile.json`, JSON.stringify(fragment, null, 2));
    }

</script>

<div>
    <h3 class="text-base font-bold mt-4 mb-1 text-textcolor">{language.profileSection}</h3>

    <section>
        <SettingRenderer items={basicInfoItems} target={preset} layout="row" />

        {#if hasInfoFields}
            <div class="border-t border-darkborderc">
                <SchemaFormRenderer
                    schema={preset.profileSnapshot.schema}
                    uiSchema={preset.profileSnapshot.uiSchema}
                    userValues={preset.userValues}
                    visibility="info"
                    showGroupLabels={false}
                    {preset}
                />
            </div>
        {/if}

        {#if streamingAvailable}
            <div class="border-t border-darkborderc">
                <SettingRenderer items={responseItems} target={preset} layout="row" />
            </div>
        {/if}
    </section>

    <div class="flex flex-col gap-1 p-3 mt-8 rounded-md border border-darkborderc bg-darkbg/40">
        <div class="flex items-center justify-between gap-2">
            <span class="text-sm text-textcolor truncate">{profileDisplayId}</span>
            {#if updateStatus === 'updatable'}
                <button class="text-xs px-2 py-0.5 rounded border border-amber-500 text-amber-500 hover:bg-amber-500/10 cursor-pointer shrink-0" onclick={applyUpdate}>{language.profileUpdateAvailable}</button>
            {:else if updateStatus === 'missing'}
                <span class="text-xs px-2 py-0.5 rounded border border-darkborderc text-textcolor2 shrink-0">{language.profileSourceMissing}</span>
            {/if}
        </div>
        {#if description}
            <div class="text-xs text-textcolor2">{description}</div>
        {/if}
        <div class="text-xs text-textcolor2">
            {language.profileProviderLabel}: {preset.profileSnapshot.providerBaseId}
        </div>
        {#if showDefaultModel}
            <div class="text-xs text-textcolor2">Default model: {preset.profileSnapshot.modelId}</div>
        {/if}
        {#if installedLabel}
            <div class="text-xs text-textcolor2">
                {language.profileUpdatedAtLabel}: {installedLabel}{#if updateStatus === 'updatable' && latestLabel && latestLabel !== installedLabel}{' '}({language.profileLatestVersionLabel}: {latestLabel}){/if}
            </div>
        {/if}
        {#if modelReleaseDate}
            <div class="text-xs text-textcolor2">
                {language.profileModelReleaseDateLabel}: {modelReleaseDate}
            </div>
        {/if}
        {#if dataCutoff}
            <div class="text-xs text-textcolor2">
                {language.profileDataCutoffLabel}: {dataCutoff}
            </div>
        {/if}
        {#if preset.profileSnapshot.capabilities && preset.profileSnapshot.capabilities.length > 0}
            <div class="flex flex-wrap gap-1 mt-1">
                {#each preset.profileSnapshot.capabilities as cap}
                    <span class="text-xs px-2 py-0.5 rounded border border-darkborderc text-textcolor2">{cap}</span>
                {/each}
            </div>
        {/if}
        <div class="flex gap-2 mt-2">
            <ShButton size="sm" className="flex-1" onclick={replaceProfile}>
                <RefreshCwIcon class="shrink-0" />
                <span class="ml-1">{language.profileReplace}</span>
            </ShButton>
            <ShButton size="sm" className="flex-1" onclick={exportPreset}>
                <DownloadIcon class="shrink-0" />
                <span class="ml-1">{language.profileExport}</span>
            </ShButton>
        </div>
    </div>

    <div class="flex flex-col gap-2 mt-8">
        <ShButton variant="default" size="default" className="w-full" onclick={duplicate}>
            <CopyIcon/>
            <span class="ml-1">{language.presetDuplicate}</span>
        </ShButton>
        <ShButton variant="destructive" size="default" className="w-full" onclick={remove}>
            <Trash2Icon/>
            <span class="ml-1">{language.presetDelete}</span>
        </ShButton>
    </div>
</div>
