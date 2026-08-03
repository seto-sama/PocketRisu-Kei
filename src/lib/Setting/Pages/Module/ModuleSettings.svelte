<script lang="ts">
    import { language } from "src/lang";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import SettingLayout from "src/lib/Setting/Wrappers/SettingLayout.svelte";
    
    import { DBState } from 'src/ts/stores.svelte';
    import Button from "src/lib/UI/GUI/Button.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import ShSwitch from "src/lib/UI/GUI/ShSwitch.svelte";
    import PresetPickerLayout from "src/lib/UI/PresetPickerLayout.svelte";
    import ModuleMenu from "src/lib/Setting/Pages/Module/ModuleMenu.svelte";
    import { exportModule, exportModuleLegacy, importModule, refreshModules, type RisuModule } from "src/ts/process/modules";
    import { SquarePen, TrashIcon, Globe, Share2Icon, PlusIcon, HardDriveUpload, Waypoints, UserIcon } from "@lucide/svelte";
    import { v4 } from "uuid";
    import { alertConfirm, alertSelect, notifySuccess } from "src/ts/alert";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import { onDestroy } from "svelte";
    import { importMCPModule } from "src/ts/process/mcp/mcp";
    import { convertModuleToCharacter } from "src/ts/interchangeability";
    import { checkCharOrder, requestImmediateSave } from "src/ts/globalApi.svelte";
    import { getCharImage } from "src/ts/characters";
    import IconButton from "src/lib/UI/GUI/IconButton.svelte";
    import IconButtonGroup from "src/lib/UI/GUI/IconButtonGroup.svelte";
    import ShSortableList from "src/lib/UI/GUI/ShSortableList.svelte";
    let tempModule:RisuModule = $state({
        name: '',
        description: '',
        id: v4(),
    })
    let mode = $state(0)
    let editModuleIndex = $state(-1)
    let moduleSearch = $state('')
    let charConversionMode = $state(false)
    let personaModuleTarget:RisuModule|null = $state(null)
    let personaModuleDraft:string[] = $state([])
    let personaFolder = $state('all')
    let personaSearch = $state('')
    let visiblePersonaIndexes = $state<number[]>([])
    let emptyPersonaMessage = $state('')
    const personaFolders = $derived(DBState.db.personaFolders ?? [])
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
        if (isModuleIntegrated(rmodule)) return "text-highlight hover:text-primary cursor-pointer"
        return "text-textcolor2 hover:text-primary cursor-pointer"
    }

    function openPersonaModuleModal(rmodule: RisuModule, e: MouseEvent) {
        e.preventDefault()
        e.stopPropagation()
        ensurePersonaIds()
        const map = getPersonaEnabledModules()
        personaModuleTarget = rmodule
        personaFolder = 'all'
        personaSearch = ''
        personaModuleDraft = DBState.db.personas
            .map((persona) => persona.id)
            .filter((id): id is string => !!id && map[id]?.includes(rmodule.id))
    }

    function setPersonaModuleDraft(personaId: string, checked: boolean) {
        if (checked) {
            if (!personaModuleDraft.includes(personaId)) {
                personaModuleDraft = [...personaModuleDraft, personaId]
            }
            return
        }
        personaModuleDraft = personaModuleDraft.filter((id) => id !== personaId)
    }

    function togglePersonaModuleDraft(index: number) {
        const personaId = DBState.db.personas[index]?.id
        if (!personaId) return
        setPersonaModuleDraft(personaId, !personaModuleDraft.includes(personaId))
    }

    function closePersonaModuleModal() {
        personaModuleTarget = null
        personaModuleDraft = []
    }

    function savePersonaModuleModal() {
        if (!personaModuleTarget) return
        const moduleId = personaModuleTarget.id
        const selected = new Set(personaModuleDraft)
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
        closePersonaModuleModal()
        notifySuccess(language.moduleUpdated)
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
            <IconButton onclick={async () => {
                tempModule = {
                    name: '',
                    description: '',
                    id: v4(),
                }
                mode = 1
            }}>
                <PlusIcon />
            </IconButton>
            <IconButton
                className={charConversionMode ? 'text-scoped' : ''}
                title={language.convertToCharacter}
                onclick={() => {
                    charConversionMode = !charConversionMode
                }}
            >
                <UserIcon />
            </IconButton>
            <IconButton onclick={async () => {
                importModule()
            }}>
                <HardDriveUpload  />
            </IconButton>
        {:else}
            <IconButton onclick={async () => {
                await importMCPModule()
            }}>
                <Waypoints />
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
                    class="mt-2 flex items-center text-textcolor border border-darkborderc rounded-md p-3 hover:bg-selected/30 transition-colors text-left cursor-grab active:cursor-grabbing"
                    role="button"
                    tabindex="0"
                    onclick={() => {
                        if (rmodule.mcp) return
                        tempModule = rmodule
                        editModuleIndex = index
                        mode = 2
                    }}
                >
                    <div class="flex flex-col min-w-0 grow">
                        <span class="text-sm text-textcolor truncate flex items-center gap-1.5">
                            {#if rmodule.mcp}
                                <Waypoints size={16} class="shrink-0 text-textcolor2" />
                            {/if}
                            <span class="truncate">{rmodule.name}</span>
                        </span>
                        <span class="text-xs text-textcolor2 truncate">{rmodule.description || 'No description provided'}</span>
                    </div>
                    <IconButtonGroup size="default" className="no-sort shrink-0 ml-2">
                        {#if charConversionMode}
                            <IconButton
                                className="text-scoped"
                                title={language.convertToCharacter}
                                onclick={(e) => {
                                    e.stopPropagation()
                                    const character = convertModuleToCharacter(rmodule)
                                    DBState.db.characters.push(character)
                                    checkCharOrder()
                                    notifySuccess(language.successfullyConverted)
                                }}
                            >
                                <UserIcon />
                            </IconButton>
                        {:else}
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
                                <Globe />
                            </IconButton>
                            {#if !rmodule.mcp}
                                <IconButton title={language.download} onclick={async (e) => {
                                    e.stopPropagation()
                                    const sel = parseInt(await alertSelect([`CharX (${language.recommended})`, `RisuM (Legacy)`]))
                                    if(sel === 0){
                                        exportModule(rmodule)
                                    }
                                    else{
                                        exportModuleLegacy(rmodule)
                                    }
                                }}>
                                    <Share2Icon />
                                </IconButton>
                                <IconButton title={language.edit} onclick={async (e) => {
                                    e.stopPropagation()
                                    tempModule = rmodule
                                    editModuleIndex = index
                                    mode = 2
                                }}>
                                    <SquarePen />
                                </IconButton>
                            {:else}
                                <IconButton disabled>
                                    <Share2Icon />
                                </IconButton>
                                <IconButton disabled>
                                    <SquarePen />
                                </IconButton>
                            {/if}
                            <IconButton tone="destructive" title={language.remove} onclick={async (e) => {
                                e.stopPropagation()
                                const d = await alertConfirm(`${language.removeConfirm}` + rmodule.name)
                                if(d){
                                    if(DBState.db.enabledModules.includes(rmodule.id)){
                                        DBState.db.enabledModules.splice(DBState.db.enabledModules.indexOf(rmodule.id), 1)
                                        DBState.db.enabledModules = DBState.db.enabledModules
                                    }
                                    const map = {...(DBState.db.personaEnabledModules ?? {})}
                                    for (const personaId of Object.keys(map)) {
                                        map[personaId] = map[personaId].filter((id) => id !== rmodule.id)
                                        if (map[personaId].length === 0) {
                                            delete map[personaId]
                                        }
                                    }
                                    DBState.db.personaEnabledModules = map
                                    DBState.db.modules.splice(index, 1)
                                    DBState.db.modules = DBState.db.modules
                                    notifySuccess(language.moduleDeleted)
                                }
                            }}>
                                <TrashIcon />
                            </IconButton>
                        {/if}
                    </IconButtonGroup>
                </div>
            {/each}
        {/if}
    </ShSortableList>

    {#if personaModuleTarget}
        <PresetPickerLayout
            title="페르소나 연동 설정"
            titleHelp="체크된 페르소나가 사용 중인 채팅에서만 해당 모듈이 활성화됩니다."
            folders={personaFolders}
            itemFolderIds={DBState.db.personas.map(persona => persona.folderId)}
            itemNames={DBState.db.personas.map(persona => persona.name ?? '')}
            itemSearchTexts={DBState.db.personas.map(persona => `${persona.name ?? ''}\n${persona.note ?? ''}`)}
            searchPlaceholder={language.personaSearch}
            manageFolders={false}
            itemDragDataKey="personaModuleIndex"
            bind:selectedFolder={personaFolder}
            bind:searchQuery={personaSearch}
            bind:visibleItemIndexes={visiblePersonaIndexes}
            bind:emptyMessage={emptyPersonaMessage}
            close={closePersonaModuleModal}
            onSelectItem={togglePersonaModuleDraft}
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
                    checked={!!persona.id && personaModuleDraft.includes(persona.id)}
                    className="mr-1"
                />
            {/snippet}

            <div class="flex justify-end gap-2 pt-2">
                <ShButton variant="outline" onclick={closePersonaModuleModal}>{language.cancel}</ShButton>
                <ShButton variant="primary" onclick={savePersonaModuleModal}>{language.confirm}</ShButton>
            </div>
        </PresetPickerLayout>
    {/if}

    </SettingPage>
{:else if mode === 1}
    <SettingPage title={language.createModule}>
    <ModuleMenu bind:currentModule={tempModule}/>
    <Button className="mt-6" onclick={() => {
        DBState.db.modules.push(tempModule)
        notifySuccess(language.moduleCreated)
        mode = 0
    }}>{language.createModule}</Button>
    </SettingPage>
{:else if mode === 2}
    <SettingPage title={language.editModule}>
    <ModuleMenu bind:currentModule={tempModule}/>
    {#if tempModule.name !== ''}
        <Button className="mt-6" onclick={() => {
            DBState.db.modules[editModuleIndex] = tempModule
            notifySuccess(language.moduleUpdated)
            mode = 0
        }}>{language.editModule}</Button>
        <Button className="mt-2" onclick={() => {
            const char = convertModuleToCharacter(tempModule)
            DBState.db.characters.push(char)
            checkCharOrder()
            notifySuccess(language.successfullyConverted)
        }}>{language.convertToCharacter}</Button>
    {/if}
    </SettingPage>
{/if}
