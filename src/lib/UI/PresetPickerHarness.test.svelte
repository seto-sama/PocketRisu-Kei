<script lang="ts">
    import PresetPickerLayout from './PresetPickerLayout.svelte';
    import InlineEditableName from './components/InlineEditableName.svelte';

    let {
        onSelect = (_index: number) => {},
        onSelectNone,
        onDelete = (_index: number) => {},
        onDuplicate = (_index: number) => {},
        names = $bindable(['First preset', 'Second preset']),
    }: {
        onSelect?: (index: number) => void;
        onSelectNone?: () => void;
        onDelete?: (index: number) => void;
        onDuplicate?: (index: number) => void;
        names?: string[];
    } = $props();
</script>

<PresetPickerLayout
    title="Preset picker"
    folders={[{ id: 'empty', name: 'Empty folder' }]}
    itemFolderIds={names.map(() => undefined)}
    itemNames={names}
    itemDragDataKey="testPresetIndex"
    onSelectItem={onSelect}
    {onSelectNone}
    noneLabel="바인딩 안 함"
    noneSelected
    onDeleteItem={onDelete}
    onDuplicateItem={onDuplicate}
    onExportItem={() => {}}
    onFoldersChange={() => {}}
    onAssignItem={() => {}}
    onDeleteFolder={() => {}}
    itemRenameable
>
    {#snippet itemContent(index, controller)}
        <InlineEditableName {controller} bind:value={names[index]} onActivate={() => onSelect(index)} />
    {/snippet}
</PresetPickerLayout>
