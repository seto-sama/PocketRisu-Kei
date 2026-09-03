<script lang="ts">
    import { language } from "src/lang";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import SettingLayout from "src/lib/Setting/Wrappers/SettingLayout.svelte";
    
    import { DBState } from 'src/ts/stores.svelte';
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import ShSwitch from "src/lib/UI/GUI/ShSwitch.svelte";
    import PresetPickerLayout from "src/lib/UI/PresetPickerLayout.svelte";
    import ModuleMenu from "src/lib/Setting/Pages/Module/ModuleMenu.svelte";
    import { exportModule, exportModuleLegacy, importModule, refreshModules, type RisuModule } from "src/ts/process/modules";
    import { BotIcon, DownloadIcon, FolderCogIcon, TrashIcon, GlobeIcon, PlusIcon, UploadIcon, Undo2Icon, UserRoundIcon, WaypointsIcon } from "@lucide/svelte";
    import { v4 } from "uuid";
    import { alertConfirm, alertSelect, notifySuccess } from "src/ts/alert";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import { onDestroy } from "svelte";
    import { builtInMCPIds, importMCPModule, type BuiltInMCPId } from "src/ts/process/mcp/mcp";
    import { convertModuleToCharacter } from "src/ts/interchangeability";
    import { checkCharOrder, requestImmediateSave } from "src/ts/globalApi.svelte";
    import { getCharImage } from "src/ts/characters";
    import IconButton from "src/lib/UI/GUI/IconButton.svelte";
    import IconButtonGroup from "src/lib/UI/GUI/IconButtonGroup.svelte";
    import ShSortableList from "src/lib/UI/GUI/ShSortableList.svelte";
    import ModelPresetList from "src/lib/UI/ModelPresetList.svelte";
    import { openSettings, SettingsRoute } from "src/ts/routing";
    import ShDialog from "src/lib/UI/GUI/ShDialog.svelte";
    import ShSelect from "src/lib/UI/GUI/ShSelect.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import ModuleChatMenu from "src/lib/Setting/Pages/Module/ModuleChatMenu.svelte";
    let tempModule:RisuModule = $state({
        name: '',
        description: '',
        id: v4(),
    })
    let mode = $state(0)
    let moduleSearch = $state('')
    let modelBindingMode = $state(false)
    let moduleFolderManagementOpen = $state(false)
    let personaModuleTarget:RisuModule|null = $state(null)
    let personaModuleSelection:string[] = $state([])
    let personaFolder = $state('all')
    let personaSearch = $state('')
    let visiblePersonaIndexes = $state<number[]>([])
    let emptyPersonaMessage = $state('')
    let mcpImportOpen = $state(false)
    let mcpImportSource = $state<string>(builtInMCPIds[0])
    let customMCPAddress = $state('')
    let mcpImporting = $state(false)
    const personaFolders = $derived(DBState.db.personaFolders ?? [])
    const selectedMCPAddress = $derived(
        mcpImportSource === 'custom' ? customMCPAddress.trim() : mcpImportSource
    )
    const selectedMCPAlreadyImported = $derived(
        !!selectedMCPAddress && DBState.db.modules.some(rmodule => rmodule.mcp?.url === selectedMCPAddress)
    )
    DBState.db.moduleModelBindings ??= {}
    let {
        embedded = false,
        view = 'modules',
    }: {
        embedded?: boolean;
        view?: 'modules' | 'mcp';
    } = $props();

    function filteredModules(modules:RisuModule[], search:string){
        return modules.map((rmodule, index) => ({ rmodule, index })).filter(({ rmodule }) => {
            if (view === 'mcp' ? !rmodule.mcp : !!rmodule.mcp) return false
            if(search === '') return true
            return rmodule.name.toLowerCase().includes(search.toLowerCase())
        })
    }

    const visibleModules = $derived(filteredModules(DBState.db.modules, moduleSearch))
    const managedModuleCount = $derived(DBState.db.modules.filter((rmodule) => view === 'mcp' ? !!rmodule.mcp : !rmodule.mcp).length)

    function ensurePersonaIds() {
        for (const persona of DBState.db.personas) {
            persona.id ??= v4()
        }
    }

    function getPersonaEnabledModules() {
        DBState.db.personaEnabledModules ??= {}
        return DBState.db.personaEnabledModules
    }

    function hasPersonaEnabledModule(moduleId: string) {
        const map = DBState.db.personaEnabledModules ?? {}
        return DBState.db.personas.some((persona) => persona.id && map[persona.id]?.includes(moduleId))
    }

    function isModuleIntegrated(rmodule: RisuModule) {
        return !!(
            rmodule.namespace &&
            DBState.db.moduleIntergration?.split(',').map((s) => s.trim()).includes(rmodule.namespace)
        )
    }

    function globalButtonClass(rmodule: RisuModule) {
        if (hasPersonaEnabledModule(rmodule.id)) return "cursor-pointer text-scoped"
        if (DBState.db.enabledModules.includes(rmodule.id)) return "cursor-pointer text-primary"
        if (isModuleIntegrated(rmodule)) return "text-highlight risu-interactive-accent cursor-pointer"
        return "text-textcolor2 risu-interactive-accent cursor-pointer"
    }

    function setModuleModelBinding(moduleId: string, presetId: string) {
        const bindings = { ...(DBState.db.moduleModelBindings ?? {}) }
        if (presetId) bindings[moduleId] = presetId
        else delete bindings[moduleId]
        DBState.db.moduleModelBindings = bindings
    }

    function openPersonaModuleModal(rmodule: RisuModule, e: MouseEvent) {
        e.preventDefault()
        e.stopPropagation()
        ensurePersonaIds()
        const map = getPersonaEnabledModules()
        personaModuleTarget = rmodule
        personaFolder = 'all'
        personaSearch = ''
        personaModuleSelection = DBState.db.personas
            .map((persona) => persona.id)
            .filter((id): id is string => !!id && map[id]?.includes(rmodule.id))
    }

    function setPersonaModuleSelection(personaId: string, checked: boolean) {
        let next: string[]
        if (checked) {
            next = personaModuleSelection.includes(personaId)
                ? personaModuleSelection
                : [...personaModuleSelection, personaId]
        } else {
            next = personaModuleSelection.filter((id) => id !== personaId)
        }
        personaModuleSelection = next
        savePersonaModuleSelection(next)
    }

    function togglePersonaModuleSelection(index: number) {
        const personaId = DBState.db.personas[index]?.id
        if (!personaId) return
        setPersonaModuleSelection(personaId, !personaModuleSelection.includes(personaId))
    }

    function closePersonaModuleModal() {
        personaModuleTarget = null
        personaModuleSelection = []
    }

    function savePersonaModuleSelection(selectedPersonaIds: string[]) {
        if (!personaModuleTarget) return
        const moduleId = personaModuleTarget.id
        const selected = new Set(selectedPersonaIds)
        const map = {...getPersonaEnabledModules()}
        for (const persona of DBState.db.personas) {
            if (!persona.id) continue
            const modules = new Set(map[persona.id] ?? [])
            if (selected.has(persona.id)) {
                modules.add(moduleId)
            } else {
                modules.delete(moduleId)
            }
            const nextModules = Array.from(modules)
            if (nextModules.length > 0) {
                map[persona.id] = nextModules
            } else {
                delete map[persona.id]
            }
        }
        DBState.db.personaEnabledModules = map
        void requestImmediateSave()
    }

    function openPersonaSettings() {
        closePersonaModuleModal()
        openSettings(SettingsRoute.Persona)
    }

    function reorderModules(orderedIds: string[]) {
        const modules = DBState.db.modules
        const visibleById = new Map(visibleModules.map(({ rmodule }) => [rmodule.id, rmodule]))
        const reorderedVisible = orderedIds
            .map((id) => visibleById.get(id))
            .filter((rmodule): rmodule is RisuModule => !!rmodule)
        if (reorderedVisible.length !== orderedIds.length) return

        const visibleIds = new Set(orderedIds)
        let visibleIndex = 0
        DBState.db.modules = modules.map((rmodule) =>
            visibleIds.has(rmodule.id)
                ? reorderedVisible[visibleIndex++] ?? rmodule
                : rmodule
        )
    }

    function startCreateModule() {
        tempModule = {
            name: '',
            description: '',
            id: v4(),
        }
        moduleFolderManagementOpen = false
        mode = 1
    }

    function duplicateModule(index: number) {
        const source = DBState.db.modules[index]
        if (!source || source.mcp) return
        const duplicate = safeStructuredClone(source)
        duplicate.id = v4()
        duplicate.name = `${source.name} Copy`
        DBState.db.modules.splice(index + 1, 0, duplicate)
        DBState.db.modules = [...DBState.db.modules]
        void requestImmediateSave()
        notifySuccess(language.moduleDuplicated)
    }

    async function downloadModule(index: number) {
        const rmodule = DBState.db.modules[index]
        if (!rmodule || rmodule.mcp) return
        const selection = parseInt(await alertSelect([`CharX (${language.recommended})`, `RisuM (Legacy)`]))
        if (selection === 0) await exportModule(rmodule)
        else if (selection === 1) await exportModuleLegacy(rmodule)
    }

    async function deleteModule(index: number) {
        const rmodule = DBState.db.modules[index]
        if (!rmodule || !await alertConfirm(`${language.removeConfirm}${rmodule.name}`)) return

        DBState.db.enabledModules = DBState.db.enabledModules.filter((id) => id !== rmodule.id)

        const personaMap = { ...(DBState.db.personaEnabledModules ?? {}) }
        for (const personaId of Object.keys(personaMap)) {
            personaMap[personaId] = personaMap[personaId].filter((id) => id !== rmodule.id)
            if (personaMap[personaId].length === 0) delete personaMap[personaId]
        }
        DBState.db.personaEnabledModules = personaMap

        const modelBindings = { ...(DBState.db.moduleModelBindings ?? {}) }
        delete modelBindings[rmodule.id]
        DBState.db.moduleModelBindings = modelBindings

        for (const character of DBState.db.characters) {
            if (character.modules?.includes(rmodule.id)) {
                character.modules = character.modules.filter((id) => id !== rmodule.id)
            }
            for (const chat of character.chats) {
                if (chat.modules?.includes(rmodule.id)) {
                    chat.modules = chat.modules.filter((id) => id !== rmodule.id)
                }
            }
        }

        DBState.db.modules = DBState.db.modules.filter((_, moduleIndex) => moduleIndex !== index)
        void requestImmediateSave()
        notifySuccess(language.moduleDeleted)
    }

    function editModule(rmodule: RisuModule) {
        if (rmodule.mcp) return
        tempModule = rmodule
        mode = 2
    }

    function finishEditingModule() {
        refreshModules()
        void requestImmediateSave()
        mode = 0
    }

    function builtInMCPLabel(id:BuiltInMCPId):string {
        switch(id){
            case 'internal:aiaccess': return language.mcpImport.builtIn.aiAccess
            case 'internal:risuai': return language.mcpImport.builtIn.risuAccess
            case 'internal:fs': return language.mcpImport.builtIn.fileSystem
            case 'internal:googlesearch': return language.mcpImport.builtIn.googleSearch
            case 'internal:dice': return language.mcpImport.builtIn.dice
            case 'internal:graphmem': return language.mcpImport.builtIn.graphMemory
        }
    }

    function openMCPImportDialog() {
        mcpImportSource = builtInMCPIds[0]
        customMCPAddress = ''
        mcpImportOpen = true
    }

    async function submitMCPImport() {
        if (!selectedMCPAddress || selectedMCPAlreadyImported || mcpImporting) return
        mcpImporting = true
        try {
            if (await importMCPModule(selectedMCPAddress)) {
                mcpImportOpen = false
            }
        } finally {
            mcpImporting = false
        }
    }

    onDestroy(() => {
        refreshModules()
    })
</script>
{#if mode === 0}
    <SettingPage title={embedded ? undefined : view === 'mcp' ? 'MCP' : language.modules}>

    <SettingLayout variant="search" className="mt-4">
        <TextInput className="min-w-0 grow" placeholder={language.search} bind:value={moduleSearch} />
        {#snippet control()}
        <IconButtonGroup size="lg">
        {#if view === 'modules'}
            <IconButton onclick={startCreateModule} title={language.createModule} aria-label={language.createModule}>
                <PlusIcon />
            </IconButton>
            <IconButton
                title={language.importModule}
                aria-label={language.importModule}
                onclick={() => { void importModule() }}
            >
                <UploadIcon />
            </IconButton>
            <IconButton
                className={modelBindingMode ? 'text-primary' : 'text-textcolor2'}
                title={language.moduleModelBindingEnable}
                aria-label={language.moduleModelBindingEnable}
                onclick={() => {
                    modelBindingMode = !modelBindingMode
                }}
            >
                <BotIcon />
            </IconButton>
            <IconButton
                title={language.moduleFolderManagement}
                aria-label={language.moduleFolderManagement}
                onclick={() => (moduleFolderManagementOpen = true)}
            >
                <FolderCogIcon />
            </IconButton>
        {:else}
            <IconButton title={language.mcpImport.title} onclick={openMCPImportDialog}>
                <WaypointsIcon />
            </IconButton>
        {/if}
        </IconButtonGroup>
        {/snippet}
    </SettingLayout>

    <ShSortableList
        className="contain w-full max-w-full mt-4 flex flex-col gap-1 flex-1 overflow-y-auto"
        onReorder={reorderModules}
    >
        {#if managedModuleCount === 0}
            <div class="text-textcolor2 text-sm text-center py-8">{view === 'mcp' ? language.noData : language.noModules}</div>
        {:else}
            {#if visibleModules.length === 0}
                <div class="text-textcolor2 text-sm text-center py-8">{language.noData}</div>
            {/if}
            {#each visibleModules as { rmodule, index } (rmodule.id)}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <div
                    data-sortable-key={rmodule.id}
                    class={`mt-2 flex ${modelBindingMode ? 'flex-wrap' : ''} items-center text-textcolor border border-darkborderc rounded-md p-3 risu-interactive-surface transition-colors text-left cursor-grab active:cursor-grabbing`}
                    role="button"
                    tabindex="0"
                    onclick={() => editModule(rmodule)}
                    onkeydown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return
                        event.preventDefault()
                        editModule(rmodule)
                    }}
                >
                    <div class={`flex flex-col min-w-0 grow ${modelBindingMode ? 'basis-full sm:basis-0' : ''}`}>
                        <span class="text-sm text-textcolor truncate flex items-center gap-1.5">
                            {#if rmodule.mcp}
                                <WaypointsIcon size={16} class="shrink-0 text-textcolor2" />
                            {/if}
                            <span class="truncate">{rmodule.name}</span>
                        </span>
                        <span class="text-xs text-textcolor2 truncate">{rmodule.description || 'No description provided'}</span>
                    </div>
                    <div
                        role="toolbar"
                        tabindex="-1"
                        aria-label={rmodule.name}
                        class={`no-sort shrink-0 ${modelBindingMode ? 'w-full sm:w-auto mt-2 sm:mt-0' : 'ml-2'} flex flex-wrap items-center justify-end gap-2`}
                        onclick={(e) => e.stopPropagation()}
                    >
                        {#if modelBindingMode && !rmodule.mcp}
                            <ModelPresetList
                                compact
                                blankable
                                blankLabel={language.moduleModelBindingUnset}
                                value={DBState.db.moduleModelBindings[rmodule.id] ?? ''}
                                onChange={(presetId) => setModuleModelBinding(rmodule.id, presetId)}
                            />
                        {:else}
                            <IconButtonGroup size="default">
                            <IconButton
                                className={globalButtonClass(rmodule)}
                                title={language.enableGlobal}
                                oncontextmenu={(e) => openPersonaModuleModal(rmodule, e)}
                                onclick={async (e) => {
                                e.stopPropagation()
                                if(DBState.db.enabledModules.includes(rmodule.id)){
                                    DBState.db.enabledModules.splice(DBState.db.enabledModules.indexOf(rmodule.id), 1)
                                }
                                else{
                                    DBState.db.enabledModules.push(rmodule.id)
                                }
                                DBState.db.enabledModules = DBState.db.enabledModules
                            }}
                            >
                                <GlobeIcon />
                            </IconButton>
                            {#if !rmodule.mcp}
                                <IconButton title={language.download} onclick={(e) => {
                                    e.stopPropagation()
                                    void downloadModule(index)
                                }}>
                                    <DownloadIcon />
                                </IconButton>
                            {/if}
                            <IconButton tone="destructive" title={language.remove} onclick={(e) => {
                                e.stopPropagation()
                                void deleteModule(index)
                            }}>
                                <TrashIcon />
                            </IconButton>
                            </IconButtonGroup>
                        {/if}
                    </div>
                </div>
            {/each}
        {/if}
    </ShSortableList>

    {#if personaModuleTarget}
        <PresetPickerLayout
            title={language.personaModuleBinding}
            titleHelp={language.help.personaModuleBinding}
            folders={personaFolders}
            itemFolderIds={DBState.db.personas.map(persona => persona.folderId)}
            itemNames={DBState.db.personas.map(persona => persona.name ?? '')}
            itemSearchTexts={DBState.db.personas.map(persona => `${persona.name ?? ''}\n${persona.note ?? ''}`)}
            searchPlaceholder={language.personaSearch}
            readOnly
            itemDragDataKey="personaModuleIndex"
            bind:selectedFolder={personaFolder}
            bind:searchQuery={personaSearch}
            bind:visibleItemIndexes={visiblePersonaIndexes}
            bind:emptyMessage={emptyPersonaMessage}
            close={closePersonaModuleModal}
            onSelectItem={togglePersonaModuleSelection}
            onFoldersChange={(next) => {
                DBState.db.personaFolders = next
                void requestImmediateSave()
            }}
            onAssignItem={(index, folderId) => {
                const persona = DBState.db.personas[index]
                if (!persona) return
                persona.folderId = folderId
                DBState.db.personas = [...DBState.db.personas]
                void requestImmediateSave()
            }}
            onDeleteFolder={(folderId) => {
                DBState.db.personas = DBState.db.personas.map(persona =>
                    persona.folderId === folderId ? { ...persona, folderId: undefined } : persona
                )
                void requestImmediateSave()
            }}
            configure={openPersonaSettings}
        >
            {#snippet itemContent(index)}
                {@const persona = DBState.db.personas[index]}
                <div class="mr-2 h-7 w-7 shrink-0 overflow-hidden rounded-md bg-textcolor2">
                    {#if persona.icon}
                        {#await getCharImage(persona.icon, 'css') then imageStyle}
                            <div class="h-full w-full bg-cover bg-center" style={imageStyle}></div>
                        {/await}
                    {/if}
                </div>
                <div class="min-w-0 grow truncate">
                    <span>{persona.name}</span>
                    {#if persona.note}<span class="text-textcolor2"> / {persona.note}</span>{/if}
                </div>
                <ShSwitch
                    checked={!!persona.id && personaModuleSelection.includes(persona.id)}
                    className="mr-1"
                />
            {/snippet}
        </PresetPickerLayout>
    {/if}

    {#if moduleFolderManagementOpen}
        <ModuleChatMenu
            folderManagement
            close={() => (moduleFolderManagementOpen = false)}
            onCreateModule={startCreateModule}
            onImportModule={importModule}
            onDuplicateModule={duplicateModule}
            onExportModule={downloadModule}
            onDeleteModule={deleteModule}
        />
    {/if}

    </SettingPage>
{:else if mode === 1}
    <SettingPage title={language.createModule}>
    <ModuleMenu bind:currentModule={tempModule}/>
    <ShButton className="mt-6" onclick={() => {
        DBState.db.modules.push(tempModule)
        notifySuccess(language.moduleCreated)
        mode = 0
    }}>{language.createModule}</ShButton>
    </SettingPage>
{:else if mode === 2}
    <SettingPage title={language.editModule}>
    {#snippet control()}
        <IconButtonGroup size="xl">
            {#if tempModule.name !== ''}
                <IconButton
                    className="text-textcolor2"
                    title={language.convertToCharacter}
                    aria-label={language.convertToCharacter}
                    onclick={async () => {
                        if (!await alertConfirm(language.convertModuleToCharacterConfirm.replace('{}', tempModule.name))) return
                        const char = convertModuleToCharacter(tempModule)
                        DBState.db.characters.push(char)
                        checkCharOrder()
                        void requestImmediateSave()
                        notifySuccess(language.successfullyConverted)
                    }}
                >
                    <UserRoundIcon />
                </IconButton>
            {/if}
            <IconButton
                className="text-textcolor2"
                title={language.backToList}
                aria-label={language.backToList}
                onclick={finishEditingModule}
            >
                <Undo2Icon />
            </IconButton>
        </IconButtonGroup>
    {/snippet}
    <ModuleMenu bind:currentModule={tempModule}/>
    </SettingPage>
{/if}

<ShDialog bind:open={mcpImportOpen} size="default" closeOnEscape={!mcpImporting} closeOnOutsideClick={!mcpImporting} closable={!mcpImporting}>
    {#snippet title()}{language.mcpImport.title}{/snippet}
    {#snippet description()}{language.mcpImport.description}{/snippet}

    <div class="flex flex-col gap-4">
        <div class="flex flex-col gap-1.5">
            <span class="text-sm text-textcolor2">{language.mcpImport.source}</span>
            <ShSelect bind:value={mcpImportSource}>
                {#each builtInMCPIds as id}
                    <OptionInput value={id}>{builtInMCPLabel(id)} ({id})</OptionInput>
                {/each}
                <OptionInput value="custom">{language.mcpImport.customSource}</OptionInput>
            </ShSelect>
        </div>

        {#if mcpImportSource === 'custom'}
            <label class="flex flex-col gap-1.5">
                <span class="text-sm text-textcolor2">{language.mcpImport.address}</span>
                <TextInput
                    bind:value={customMCPAddress}
                    placeholder={language.mcpImport.addressPlaceholder}
                    fullwidth
                />
            </label>
        {/if}

        {#if selectedMCPAlreadyImported}
            <p class="text-sm text-warning">{language.mcpImport.alreadyImported}</p>
        {/if}
    </div>

    {#snippet footer()}
        <ShButton variant="outline" onclick={() => (mcpImportOpen = false)} disabled={mcpImporting}>
            {language.cancel}
        </ShButton>
        <ShButton onclick={submitMCPImport} disabled={!selectedMCPAddress || selectedMCPAlreadyImported || mcpImporting}>
            {language.import}
        </ShButton>
    {/snippet}
</ShDialog>
