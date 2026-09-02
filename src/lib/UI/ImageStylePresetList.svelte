<script lang="ts">
    import { ArrowLeftRightIcon, SquarePenIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import { alertConfirm } from 'src/ts/alert'
    import {
        createImageStylePreset,
        createImageStyleLorebookFolder,
        formatImageStylePresetContent,
        getImageStylePresetId,
        IMAGE_STYLE_PRESET_PREFIX,
        listImageStylePresets,
        normalizeImageStylePresetName,
        parseImageStylePresetContent,
        type ImageStylePresetEntry,
    } from 'src/ts/imageGeneration/stylePresets'
    import { DBState } from 'src/ts/stores.svelte'
    import IconButton from './GUI/IconButton.svelte'
    import PresetBindingTrigger from './PresetBindingTrigger.svelte'
    import PresetPickerActions from './PresetPickerActions.svelte'
    import PresetPickerLayout from './PresetPickerLayout.svelte'
    import ShButton from './GUI/ShButton.svelte'
    import ShDialog from './GUI/ShDialog.svelte'
    import TextAreaInput from './GUI/TextAreaInput.svelte'
    import TextInput from './GUI/TextInput.svelte'
    import { v4 as uuidv4 } from 'uuid'
    import { removePresetTag, togglePresetTag } from 'src/ts/preset/tags'

    interface Props {
        compact?: boolean
        open?: boolean
    }

    let { compact = false, open = $bindable(false) }: Props = $props()
    let visibleItemIndexes = $state<number[]>([])
    let editorOpen = $state(false)
    let editingPresetId = $state('')
    let editorName = $state('')
    let editorPositive = $state('')
    let editorNegative = $state('')
    let viewMode = $state<'tag' | 'module'>('tag')
    let selectedGroup = $state('all')
    let creationModuleId = $state('')
    let creationLorebookFolder = $state('')
    let creationPresetTagId = $state('')

    const rawPresets = $derived(listImageStylePresets(DBState.db))
    const presets = $derived(viewMode === 'tag'
        ? orderPresets(rawPresets, DBState.db.imageStylePresetOrder)
        : rawPresets)
    const presetTags = $derived(DBState.db.imageStylePresetTags ?? [])
    const moduleGroups = $derived.by(() => {
        const moduleIds = new Set(presets.map(item => item.moduleId))
        return DBState.db.modules.flatMap(module => {
            if (!moduleIds.has(module.id)) return []
            return [
                { id: moduleGroupId(module.id), name: module.name, kind: 'module' as const },
                ...(module.lorebook ?? [])
                    .filter(lorebook => lorebook.mode === 'folder')
                    .map(lorebook => ({
                        id: moduleFolderGroupId(module.id, lorebook.key),
                        name: lorebook.comment || language.presetUncategorized,
                        depth: 1,
                        kind: 'folder' as const,
                    })),
            ]
        })
    })
    const activeGroups = $derived(viewMode === 'tag' ? presetTags : moduleGroups)
    const itemGroupIds = $derived(viewMode === 'tag'
        ? presets.map(item => DBState.db.imageStylePresetTagBindings?.[item.id])
        : presets.map(item => [
            moduleGroupId(item.moduleId),
            ...(item.lorebookFolder ? [moduleFolderGroupId(item.moduleId, item.lorebookFolder)] : []),
        ]))
    const selectedItemIndex = $derived(presets.findIndex(item => item.id === DBState.db.imageStylePresetId))
    const selectedPreset = $derived(presets[selectedItemIndex])
    const selectedModuleTarget = $derived(viewMode === 'module' ? parseModuleGroupId(selectedGroup) : undefined)

    function orderPresets(entries: ImageStylePresetEntry[], order: string[]): ImageStylePresetEntry[] {
        const ranks = new Map(order.map((id, index) => [id, index]))
        return entries
            .map((entry, index) => ({ entry, index }))
            .sort((a, b) => {
                const rankA = ranks.get(a.entry.id)
                const rankB = ranks.get(b.entry.id)
                if (rankA !== undefined && rankB !== undefined) return rankA - rankB
                if (rankA !== undefined) return -1
                if (rankB !== undefined) return 1
                return a.index - b.index
            })
            .map(item => item.entry)
    }

    function moduleGroupId(moduleId: string): string {
        return JSON.stringify(['module', moduleId])
    }

    function moduleFolderGroupId(moduleId: string, folder: string): string {
        return JSON.stringify(['module-folder', moduleId, folder])
    }

    function parseModuleGroupId(value: string): { moduleId: string, lorebookFolder?: string } | undefined {
        try {
            const parsed = JSON.parse(value)
            if (!Array.isArray(parsed) || typeof parsed[1] !== 'string') return undefined
            if (parsed[0] === 'module') return { moduleId: parsed[1] }
            if (parsed[0] === 'module-folder' && typeof parsed[2] === 'string') {
                return { moduleId: parsed[1], lorebookFolder: parsed[2] }
            }
        } catch {}
        return undefined
    }

    function selectPreset(index: number) {
        DBState.db.imageStylePresetId = presets[index]?.id ?? ''
        open = false
    }

    function selectNone() {
        DBState.db.imageStylePresetId = ''
        open = false
    }

    function startCreate() {
        editingPresetId = ''
        const moduleTarget = viewMode === 'module' ? parseModuleGroupId(selectedGroup) : undefined
        creationModuleId = moduleTarget?.moduleId ?? ''
        creationLorebookFolder = moduleTarget?.lorebookFolder ?? ''
        creationPresetTagId = viewMode === 'tag'
            && presetTags.some(tag => tag.id === selectedGroup)
            ? selectedGroup
            : ''
        editorName = ''
        editorPositive = ''
        editorNegative = ''
        editorOpen = true
    }

    function startEdit(preset: ImageStylePresetEntry) {
        const parsed = parseImageStylePresetContent(preset.content)
        editingPresetId = preset.id
        editorName = preset.name
        editorPositive = parsed.positive
        editorNegative = parsed.negative
        editorOpen = true
    }

    function saveEditor() {
        const name = editorName.trim()
        if (!name) return
        if (!editingPresetId) {
            const created = createImageStylePreset(DBState.db, name, editorPositive, editorNegative, {
                moduleId: creationModuleId || undefined,
                lorebookFolder: creationLorebookFolder || undefined,
            })
            if (creationPresetTagId) {
                DBState.db.imageStylePresetTagBindings = {
                    ...DBState.db.imageStylePresetTagBindings,
                    [created.id]: [creationPresetTagId],
                }
            }
            DBState.db.imageStylePresetOrder = [
                ...DBState.db.imageStylePresetOrder.filter(id => id !== created.id),
                created.id,
            ]
            DBState.db.modules = [...DBState.db.modules]
            DBState.db.enabledModules = [...DBState.db.enabledModules]
            DBState.db.imageStylePresetId = created.id
        } else {
            const preset = presets.find(item => item.id === editingPresetId)
            const module = preset && DBState.db.modules.find(item => item.id === preset.moduleId)
            const lorebook = module?.lorebook?.[preset?.lorebookIndex ?? -1]
            if (!preset || !module || !lorebook) return
            const normalizedName = normalizeImageStylePresetName(name)
            lorebook.comment = `${IMAGE_STYLE_PRESET_PREFIX}${normalizedName}`
            lorebook.content = formatImageStylePresetContent(editorPositive, editorNegative)
            DBState.db.modules = [...DBState.db.modules]
            DBState.db.imageStylePresetId = preset.id
        }
        editorOpen = false
    }

    async function deletePreset(preset: ImageStylePresetEntry) {
        if (!await alertConfirm(language.imageStylePresetDeleteConfirm)) return
        const module = DBState.db.modules.find(item => item.id === preset.moduleId)
        if (!module?.lorebook?.[preset.lorebookIndex]) return
        module.lorebook.splice(preset.lorebookIndex, 1)
        DBState.db.modules = [...DBState.db.modules]
        const nextBindings = { ...DBState.db.imageStylePresetTagBindings }
        delete nextBindings[preset.id]
        DBState.db.imageStylePresetTagBindings = nextBindings
        DBState.db.imageStylePresetOrder = DBState.db.imageStylePresetOrder.filter(id => id !== preset.id)
        if (DBState.db.imageStylePresetId === preset.id) DBState.db.imageStylePresetId = ''
    }

    function movePreset(sourceIndex: number, targetIndex: number) {
        if (sourceIndex === targetIndex || sourceIndex < 0 || sourceIndex >= presets.length) return
        if (viewMode === 'tag') {
            const nextOrder = presets.map(item => item.id)
            const [moved] = nextOrder.splice(sourceIndex, 1)
            if (!moved) return
            const insertionIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex
            nextOrder.splice(Math.max(0, Math.min(insertionIndex, nextOrder.length)), 0, moved)
            DBState.db.imageStylePresetOrder = nextOrder
            return
        }

        const selectedModule = selectedModuleTarget
        const sourcePreset = presets[sourceIndex]
        if (!selectedModule || sourcePreset.moduleId !== selectedModule.moduleId) return
        const module = DBState.db.modules.find(item => item.id === selectedModule.moduleId)
        const lorebooks = module?.lorebook
        if (!module || !lorebooks?.[sourcePreset.lorebookIndex]) return
        const targetPreset = presets[targetIndex]
        let targetLorebookIndex = targetPreset?.moduleId === module.id
            ? targetPreset.lorebookIndex
            : lorebooks.length
        const [moved] = lorebooks.splice(sourcePreset.lorebookIndex, 1)
        if (!moved) return
        if (sourcePreset.lorebookIndex < targetLorebookIndex) targetLorebookIndex -= 1
        lorebooks.splice(Math.max(0, Math.min(targetLorebookIndex, lorebooks.length)), 0, moved)
        DBState.db.modules = [...DBState.db.modules]
    }

    function createFolder(name: string): string | void {
        if (viewMode === 'tag') {
            const id = uuidv4()
            DBState.db.imageStylePresetTags = [...presetTags, { id, name }]
            return id
        }
        const target = parseModuleGroupId(selectedGroup)
        if (!target) return
        const key = createImageStyleLorebookFolder(DBState.db, target.moduleId, name)
        if (!key) return
        DBState.db.modules = [...DBState.db.modules]
        return moduleFolderGroupId(target.moduleId, key)
    }

    function assignPresetToGroup(index: number, groupId: string | undefined) {
        const preset = presets[index]
        if (!preset) return
        if (viewMode === 'tag') {
            const next = { ...DBState.db.imageStylePresetTagBindings }
            const tagIds = togglePresetTag(next[preset.id], groupId)
            if (tagIds) next[preset.id] = tagIds
            else delete next[preset.id]
            DBState.db.imageStylePresetTagBindings = next
            return
        }

        if (!groupId) return
        const target = parseModuleGroupId(groupId)
        const sourceModule = DBState.db.modules.find(item => item.id === preset.moduleId)
        const targetModule = target && DBState.db.modules.find(item => item.id === target.moduleId)
        const lorebook = sourceModule?.lorebook?.[preset.lorebookIndex]
        if (!target || !sourceModule || !targetModule || !lorebook) return

        const oldId = preset.id
        if (sourceModule.id === targetModule.id) {
            lorebook.folder = target.lorebookFolder
        } else {
            sourceModule.lorebook!.splice(preset.lorebookIndex, 1)
            lorebook.folder = target.lorebookFolder
            targetModule.lorebook ??= []
            targetModule.lorebook.push(lorebook)
        }
        DBState.db.modules = [...DBState.db.modules]

        const updatedId = getImageStylePresetId(targetModule, lorebook)
        if (updatedId === oldId) return
        if (DBState.db.imageStylePresetId === oldId) DBState.db.imageStylePresetId = updatedId
        const nextBindings = { ...DBState.db.imageStylePresetTagBindings }
        if (nextBindings[oldId]) nextBindings[updatedId] = nextBindings[oldId]
        delete nextBindings[oldId]
        DBState.db.imageStylePresetTagBindings = nextBindings
        DBState.db.imageStylePresetOrder = DBState.db.imageStylePresetOrder
            .map(id => id === oldId ? updatedId : id)
    }

    function deletePresetTag(tagId: string) {
        DBState.db.imageStylePresetTagBindings = Object.fromEntries(
            Object.entries(DBState.db.imageStylePresetTagBindings).flatMap(([presetId, tagIds]) => {
                const next = removePresetTag(tagIds, tagId)
                return next ? [[presetId, next]] : []
            }),
        )
    }

    function reorderAdjacentToVisibleItem<T>(
        items: T[],
        oldVisibleIds: string[],
        nextVisibleIds: string[],
        draggedId: string,
        getId: (item: T) => string | undefined,
    ): T[] | undefined {
        const oldIndex = oldVisibleIds.indexOf(draggedId)
        const newIndex = nextVisibleIds.indexOf(draggedId)
        if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return undefined

        const nextItems = [...items]
        const sourceIndex = nextItems.findIndex(item => getId(item) === draggedId)
        if (sourceIndex < 0) return undefined
        const [draggedItem] = nextItems.splice(sourceIndex, 1)
        if (!draggedItem) return undefined

        const neighborId = newIndex > oldIndex
            ? nextVisibleIds[newIndex - 1]
            : nextVisibleIds[newIndex + 1]
        const neighborIndex = nextItems.findIndex(item => getId(item) === neighborId)
        const insertionIndex = newIndex > oldIndex
            ? (neighborIndex >= 0 ? neighborIndex + 1 : nextItems.length)
            : (neighborIndex >= 0 ? neighborIndex : 0)
        nextItems.splice(insertionIndex, 0, draggedItem)
        return nextItems
    }

    function reorderModules(orderedGroupIds: string[], draggedGroupId: string) {
        const oldGroupIds = moduleGroups
            .filter(group => group.kind === 'module')
            .map(group => group.id)
        const nextGroupIds = orderedGroupIds.filter(id => !parseModuleGroupId(id)?.lorebookFolder)
        const modules = reorderAdjacentToVisibleItem(
            DBState.db.modules,
            oldGroupIds,
            nextGroupIds,
            draggedGroupId,
            module => moduleGroupId(module.id),
        )
        if (modules) DBState.db.modules = modules
    }

    function reorderLorebookFolders(orderedGroupIds: string[], draggedGroupId: string) {
        const dragged = parseModuleGroupId(draggedGroupId)
        if (!dragged?.lorebookFolder) return
        const module = DBState.db.modules.find(item => item.id === dragged.moduleId)
        if (!module?.lorebook) return

        const oldFolderIds = moduleGroups
            .map(group => group.id)
            .filter(id => {
                const target = parseModuleGroupId(id)
                return target?.moduleId === dragged.moduleId && !!target.lorebookFolder
            })
        const nextFolderIds = orderedGroupIds.filter(id => {
            const target = parseModuleGroupId(id)
            return target?.moduleId === dragged.moduleId && !!target.lorebookFolder
        })
        const lorebooks = reorderAdjacentToVisibleItem(
            module.lorebook,
            oldFolderIds,
            nextFolderIds,
            draggedGroupId,
            lorebook => lorebook.mode === 'folder'
                ? moduleFolderGroupId(module.id, lorebook.key)
                : undefined,
        )
        if (lorebooks) {
            module.lorebook = lorebooks
            DBState.db.modules = [...DBState.db.modules]
        }
    }

    function reorderModuleTree(orderedGroupIds: string[], draggedGroupId: string) {
        if (parseModuleGroupId(draggedGroupId)?.lorebookFolder) {
            reorderLorebookFolders(orderedGroupIds, draggedGroupId)
        } else {
            reorderModules(orderedGroupIds, draggedGroupId)
        }
    }

    function switchViewMode() {
        viewMode = viewMode === 'tag' ? 'module' : 'tag'
        selectedGroup = 'all'
    }

</script>

{#if open}
    <PresetPickerLayout
        title={language.imageStylePreset}
        folders={activeGroups}
        itemFolderIds={itemGroupIds}
        organizationKind={viewMode === 'tag' ? 'tag' : 'folder'}
        itemNames={presets.map(item => item.name)}
        itemSearchTexts={presets.map(item => `${item.name}\n${item.moduleName}`)}
        itemDragDataKey="imageStylePresetIndex"
        bind:visibleItemIndexes
        bind:selectedFolder={selectedGroup}
        close={() => { open = false }}
        readOnly={viewMode === 'module'}
        folderReadOnly={viewMode === 'module'}
        folderReorderable
        folderEditable={viewMode === 'tag'}
        itemReadOnly={false}
        allowItemDropOnReadOnlyFolders={viewMode === 'module'}
        showCreateFolder
        createFolderDisabled={viewMode === 'module' && !selectedModuleTarget}
        onCreateFolder={createFolder}
        showUncategorized={viewMode === 'tag'}
        allowFolderAssignmentDrag
        allowItemReorder={viewMode === 'tag' || !!selectedModuleTarget}
        onFoldersChange={(folders) => {
            if (viewMode === 'tag') DBState.db.imageStylePresetTags = folders
        }}
        onMoveFolder={viewMode === 'module' ? reorderModuleTree : undefined}
        onAssignItem={assignPresetToGroup}
        onDeleteFolder={deletePresetTag}
        onMoveItem={movePreset}
        onDeleteItem={(index) => { void deletePreset(presets[index]) }}
        {selectedItemIndex}
        onSelectItem={selectPreset}
    >
        {#snippet sidebarFooterActions()}
            <IconButton
                size="default"
                onclick={switchViewMode}
                title={viewMode === 'tag' ? language.imageStylePresetModuleView : language.imageStylePresetTagView}
                aria-label={viewMode === 'tag' ? language.imageStylePresetModuleView : language.imageStylePresetTagView}
            >
                <ArrowLeftRightIcon />
            </IconButton>
        {/snippet}
        {#snippet itemContent(index)}
            {@const item = presets[index]}
            <span class="grow min-w-0 truncate">
                <span>{item.name}</span>
                {#if item.moduleName}<span class="text-textcolor2"> / {item.moduleName}</span>{/if}
            </span>
        {/snippet}
        {#snippet itemActions(index)}
            {@const item = presets[index]}
            <IconButton onclick={() => startEdit(item)} aria-label={language.edit} title={language.edit}>
                <SquarePenIcon />
            </IconButton>
        {/snippet}
        {#snippet listFooter()}
            <button
                class="w-full h-10 flex items-center gap-2 rounded-md text-left px-3 text-sm text-textcolor2 {!DBState.db.imageStylePresetId ? '' : 'risu-interactive-surface'}"
                class:bg-selected={!DBState.db.imageStylePresetId}
                onclick={selectNone}
            >
                <span class="truncate">{language.imageStylePresetNone}</span>
            </button>
        {/snippet}
        <PresetPickerActions onCreate={startCreate} />
    </PresetPickerLayout>
{/if}

<PresetBindingTrigger
    {compact}
    label={language.imageStylePreset}
    activeName={selectedPreset?.name ?? language.imageStylePresetNone}
    onOpen={() => { open = true }}
    state={selectedPreset ? 'selected' : 'empty'}
/>

<ShDialog bind:open={editorOpen} size="default" closeOnEscape closeOnOutsideClick closable>
    {#snippet title()}{editingPresetId ? `${language.imageStylePreset} ${language.edit}` : language.imageStylePresetNew}{/snippet}
    <div class="flex flex-col gap-3">
        <label class="flex items-center justify-between gap-3 text-sm text-textcolor">
            <span>{language.imageStylePresetName}</span>
            <TextInput bind:value={editorName} commitMode="input" className="w-48 text-sm" size="sm" />
        </label>
        <label class="flex flex-col gap-1 text-sm text-textcolor">
            <span>{language.imageStylePresetPositive}</span>
            <TextAreaInput bind:value={editorPositive} commitMode="input" fullwidth />
        </label>
        <label class="flex flex-col gap-1 text-sm text-textcolor">
            <span>{language.imageStylePresetNegative}</span>
            <TextAreaInput bind:value={editorNegative} commitMode="input" fullwidth />
        </label>
    </div>
    {#snippet footer()}
        <ShButton variant="outline" onclick={() => { editorOpen = false }}>{language.cancel}</ShButton>
        <ShButton variant="primary" disabled={!editorName.trim()} onclick={saveEditor}>{language.confirm}</ShButton>
    {/snippet}
</ShDialog>
