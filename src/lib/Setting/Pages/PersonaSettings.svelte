<script lang="ts">
    import { ImageIcon } from "@lucide/svelte";
    import { onDestroy } from "svelte";
    import { language } from "src/lang";
    import SettingRenderer from "src/lib/Setting/SettingRenderer.svelte";
    import SettingLayout from "src/lib/Setting/Wrappers/SettingLayout.svelte";
    import PresetHeader from "src/lib/UI/GUI/PresetHeader.svelte";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import { getCharImage } from "src/ts/characters";
    import { saveUserPersona, selectUserImg } from "src/ts/persona";
    import type { SettingItem } from "src/ts/setting/types";
    import { DBState, openPersonaList } from "src/ts/stores.svelte";

    const activePersona = $derived(DBState.db.personas[DBState.db.selectedPersona]);
    const basicInfoItems: SettingItem[] = [
        {
            id: 'persona.name',
            type: 'text',
            labelKey: 'name',
            helpKey: 'personaName',
            bindKey: 'username',
        },
        {
            id: 'persona.note',
            type: 'text',
            labelKey: 'note',
            helpKey: 'personaNote',
            bindKey: 'userNote',
            options: { placeholder: '[Alternate Hunters persona]' },
        },
        {
            id: 'persona.largePortrait',
            type: 'check',
            labelKey: 'largePortrait',
            helpKey: 'personaLargePortrait',
            getValue: (db) => !!db.personas[db.selectedPersona]?.largePortrait,
            setValue: (db, value: boolean) => { db.personas[db.selectedPersona].largePortrait = value; },
        },
    ];
    const descriptionItems: SettingItem[] = [{
        id: 'persona.description',
        type: 'textarea',
        labelKey: 'description',
        helpKey: 'personaDescription',
        bindKey: 'personaPrompt',
        options: {
            placeholder: 'Put the description of this persona here.\nExample: [<user> is a 20 year old girl.]',
        },
    }];

    function openPersonaManager() {
        saveUserPersona();
        openPersonaList.set(true);
    }

    onDestroy(() => {
        saveUserPersona();
    });
</script>

<SettingPage title={language.persona}>
    <PresetHeader
        label={language.currentPersona}
        activeName={DBState.db.username || '—'}
        onManage={openPersonaManager}
    />

    <SettingLayout variant="section" title={language.basicInfo} first>
        <div class="flex items-start gap-5 py-4 max-sm:flex-col">
            <div class="flex h-[16.5rem] w-44 shrink-0 flex-col gap-2 max-sm:w-full max-sm:items-center">
                <button
                    type="button"
                    class="relative w-44 overflow-hidden rounded-md border border-darkborderc bg-textcolor2 shadow-lg transition-[height,border-color] duration-200 focus-visible:border-primary outline-none"
                    class:h-56={!!activePersona?.largePortrait}
                    class:h-44={!activePersona?.largePortrait}
                    aria-label={language.select}
                    onclick={selectUserImg}
                >
                    {#if DBState.db.userIcon}
                        {#await getCharImage(DBState.db.userIcon, 'css')}
                            <div class="h-full w-full animate-pulse bg-textcolor2"></div>
                        {:then imageStyle}
                            <div class="h-full w-full bg-cover bg-center" style={imageStyle}></div>
                        {/await}
                    {/if}
                </button>
                <ShButton variant="outline" size="sm" className="w-full max-sm:w-44" onclick={selectUserImg}>
                    <ImageIcon/>
                    {language.select}
                </ShButton>
            </div>

            <div class="min-w-0 grow">
                <SettingRenderer items={basicInfoItems} layout="row" />
            </div>
        </div>
    </SettingLayout>

    <div>
        <SettingRenderer items={descriptionItems} layout="row" />
    </div>
</SettingPage>
