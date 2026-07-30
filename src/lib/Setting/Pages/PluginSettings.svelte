<script lang="ts">
    import { PlusIcon, TrashIcon, LinkIcon, CodeXmlIcon, PowerIcon, PowerOffIcon, ShieldIcon, SquarePenIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import { alertConfirm, alertMd, alertSelect, notifySuccess } from "src/ts/alert";
    import { TriangleAlert } from '@lucide/svelte';

    import { DBState, hotReloading, popUpEditorStore } from "src/ts/stores.svelte";
    import { checkPluginUpdate, importPlugin, loadPlugins, updatePlugin, type RisuPlugin } from "src/ts/plugins/plugins.svelte";
    import { requestImmediateSave } from "src/ts/globalApi.svelte";
    import { resetPluginPermission } from "src/ts/plugins/apiV3/v3.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import SettingLayout from "src/lib/Setting/Wrappers/SettingLayout.svelte";
    import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import { hotReloadPluginFiles } from "src/ts/plugins/apiV3/developMode";
    import IconButton from "src/lib/UI/GUI/IconButton.svelte";
    import IconButtonGroup from "src/lib/UI/GUI/IconButtonGroup.svelte";

    let showParams = $state<string[]>([])
    let pluginSearch = $state('')
    let isDraggingPlugin = $state(false)
    let draggedPluginIndex = $state(-1)
    let dragOverPluginIndex = $state(-1)
    let suppressPluginClick = $state(false)
    let {
        embedded = false,
    }: {
        embedded?: boolean;
    } = $props();

    function pluginTitle(plugin: RisuPlugin) {
        return plugin.displayName ?? plugin.name
    }

    function pluginDescription(plugin: RisuPlugin) {
        const parts: string[] = []
        if (plugin.displayName && plugin.displayName !== plugin.name) parts.push(plugin.name)
        if (plugin.versionOfPlugin) parts.push(plugin.versionOfPlugin)
        if (plugin.version) parts.push(`API ${plugin.version}`)
        return parts.join(' / ') || plugin.name
    }

    function pluginKey(plugin: RisuPlugin, index: number) {
        return plugin.name || `${index}`
    }

    function filteredPlugins(plugins: RisuPlugin[] = [], search: string) {
        const normalized = search.toLowerCase()
        return plugins.map((plugin, index) => ({ plugin, index })).filter(({ plugin }) => {
            if (!normalized) return true
            return pluginTitle(plugin).toLowerCase().includes(normalized)
                || plugin.name.toLowerCase().includes(normalized)
        })
    }

    const visiblePlugins = $derived(filteredPlugins(DBState.db.plugins, pluginSearch))

    function movePlugin(fromIndex: number, toIndex: number) {
        const plugins = DBState.db.plugins ?? []
        if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= plugins.length || toIndex > plugins.length) return

        const next = [...plugins]
        const [moved] = next.splice(fromIndex, 1)
        if (!moved) return
        const adjustedToIndex = fromIndex < toIndex ? toIndex - 1 : toIndex
        next.splice(adjustedToIndex, 0, moved)
        DBState.db.plugins = next
        loadPlugins()
        void requestImmediateSave()
    }

    function startPluginDrag(index: number, e: DragEvent) {
        e.stopPropagation()
        const target = e.target as HTMLElement | null
        if (target?.closest('[data-no-row-drag="true"]')) {
            e.preventDefault()
            return
        }
        isDraggingPlugin = true
        draggedPluginIndex = index
        dragOverPluginIndex = index
        suppressPluginClick = true
        e.dataTransfer?.setData('text/plain', 'plugin')
        e.dataTransfer?.setData('pluginIndex', String(index))
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
    }

    function updatePluginDragTarget(index: number, e: DragEvent) {
        e.preventDefault()
        e.stopPropagation()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
        dragOverPluginIndex = e.clientY < rect.top + rect.height / 2 ? index : index + 1
    }

    function dropPlugin(e: DragEvent) {
        e.preventDefault()
        e.stopPropagation()
        const kind = e.dataTransfer?.getData('text/plain')
        if (kind !== 'plugin') return
        const sourceIndex = Number(e.dataTransfer?.getData('pluginIndex') || draggedPluginIndex)
        movePlugin(sourceIndex, dragOverPluginIndex)
        endPluginDrag()
    }

    function endPluginDrag() {
        isDraggingPlugin = false
        draggedPluginIndex = -1
        dragOverPluginIndex = -1
        setTimeout(() => {
            suppressPluginClick = false
        }, 0)
    }

    function openPluginScriptEditor(index: number, plugin: RisuPlugin) {
        const originalScript = plugin.script ?? ''
        popUpEditorStore.value = originalScript
        popUpEditorStore.mode = 'default'
        popUpEditorStore.language = 'javascript'
        popUpEditorStore.onSave = () => {
            const nextScript = popUpEditorStore.value
            if (nextScript === originalScript) return true

            const foundIndex = DBState.db.plugins?.findIndex((p) => p.name === plugin.name) ?? -1
            const currentIndex = foundIndex >= 0 ? foundIndex : index
            const currentPlugin = DBState.db.plugins?.[currentIndex]
            if (!currentPlugin) return true

            currentPlugin.script = nextScript
            DBState.db.plugins[currentIndex] = currentPlugin
            loadPlugins()
            void requestImmediateSave()
            notifySuccess('Plugin updated.')
            return true
        }
        popUpEditorStore.open = true
    }
</script>

{#snippet content()}
<SettingLayout variant="search" className="mt-4">
    <TextInput className="min-w-0 grow" placeholder={language.search} bind:value={pluginSearch} />
    {#snippet control()}
    <IconButtonGroup size="lg">
        <IconButton
            onclick={() => {
                importPlugin()
            }}
        >
            <PlusIcon />
        </IconButton>

        <IconButton
            onclick={async () => {
                const v = parseInt(await alertSelect([
                    "Import plugin with hot reload",
                    "Download plugin template",
                    language.cancel
                ]))
                switch(v){
                    case 0:
                        await hotReloadPluginFiles()
                        break;
                    case 1:{
                        const a = document.createElement('a');
                        a.href = '/plugin_start.7z';
                        a.download = 'plugin_starter.7z';
                        document.body.appendChild(a);
                    }
                }
            }}
        >
            <CodeXmlIcon />
        </IconButton>
    </IconButtonGroup>
    {/snippet}
</SettingLayout>

<div class="w-full max-w-full mt-4 flex flex-col gap-1 flex-1 overflow-y-auto">
    {#if !DBState.db.plugins || DBState.db.plugins?.length === 0}
        <div class="text-textcolor2 text-sm text-center py-8">{language.noPlugins}</div>
    {/if}
    {#if DBState.db.plugins && DBState.db.plugins.length > 0 && visiblePlugins.length === 0}
        <div class="text-textcolor2 text-sm text-center py-8">{language.noData}</div>
    {/if}
    {#each visiblePlugins as { plugin, index } (plugin.name)}
        <div
            class="h-1 rounded-full transition-colors"
            class:bg-primary={isDraggingPlugin && dragOverPluginIndex === index}
            class:bg-transparent={!isDraggingPlugin || dragOverPluginIndex !== index}
            role="presentation"
            ondragover={(e) => {
                e.preventDefault()
                e.stopPropagation()
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
                dragOverPluginIndex = index
            }}
            ondrop={dropPlugin}
        ></div>
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
            class="flex items-center text-textcolor border border-darkborderc rounded-md p-3 hover:bg-selected/30 transition-colors text-left cursor-grab active:cursor-grabbing"
            class:opacity-50={isDraggingPlugin && draggedPluginIndex === index}
            role="button"
            tabindex="0"
            draggable="true"
            ondragstart={(e) => startPluginDrag(index, e)}
            ondragend={endPluginDrag}
            ondragover={(e) => updatePluginDragTarget(index, e)}
            ondrop={dropPlugin}
            onclick={() => {
            if(suppressPluginClick) return
            const key = pluginKey(plugin, index)
            if(showParams.includes(key)){
                showParams.splice(showParams.indexOf(key),1)
            }
            else{
                showParams.push(key)
            }
        }}>
            <div class="flex flex-col min-w-0 grow">
                <span class="text-sm text-textcolor truncate flex items-center gap-1.5">
                    <span class="truncate">{pluginTitle(plugin)}</span>
                </span>
                <span class="text-xs text-textcolor2 truncate">{pluginDescription(plugin)}</span>
                {#if hotReloading.includes(plugin.name)}
                    <span class="text-xs rounded bg-amber-700 mt-1 px-2 py-0.5 text-white w-fit">
                        Hot
                    </span>
                {/if}
            </div>
            <IconButtonGroup size="default" className="shrink-0 ml-2" data-no-row-drag="true">
            {#if plugin.version === 2 || plugin.version === "2.1"}
                <IconButton className="text-yellow-400" onclick={(e) => {
                    e.stopPropagation()
                    alertMd(language.pluginV2Warning);
                }} >
                    <TriangleAlert />
                </IconButton>
            {/if}

            {#if plugin.customLink}
                {#each plugin.customLink as link}
                    {#if typeof link.link === "string" && (link.link.startsWith("http://") || link.link.startsWith("https://"))}
                        <a
                            href={link.link}
                            target="_blank"
                            rel="nofollow noopener noreferrer"
                            class="inline-flex size-6 shrink-0 items-center justify-center text-textcolor2 hover:text-primary"
                            title={link.hoverText}
                            onclick={(e) => { e.stopPropagation() }}
                        >
                            <LinkIcon></LinkIcon>
                        </a>
                    {/if}
                {/each}
            {/if}

            {#if plugin.updateURL}
                {#await checkPluginUpdate(plugin) then updateInfo}
                    {#if updateInfo}
                        <IconButton
                            className="text-green-400"
                            onclick={async (e) => {
                                e.stopPropagation()
                                const v = await alertConfirm(
                                    language.pluginUpdateFoundInstallIt
                                );
                                if (v) {
                                    updatePlugin(plugin)
                                }
                            }}
                        >
                            <PlusIcon />
                        </IconButton>
                    {/if}
                {/await}
            {/if}

            <IconButton
                active={plugin.enabled}
                activeColor="primary"
                onclick={async (e) => {
                    plugin.enabled = !plugin.enabled
                    DBState.db.plugins[index] = plugin
                    loadPlugins()
                    void requestImmediateSave()
                    e.stopPropagation()
                }}
            >
                {#if plugin.enabled}
                    <PowerIcon />
                {:else}
                    <PowerOffIcon />
                {/if}
            </IconButton>

            <IconButton
                title={language.resetPluginPermission}
                onclick={async (e) => {
                    e.stopPropagation()
                    const v = await alertConfirm(
                        language.resetPluginPermissionConfirm.replace("{}", plugin.displayName ?? plugin.name)
                    )
                    if (v) {
                        await resetPluginPermission(plugin.name)
                        notifySuccess(language.resetPluginPermissionDone.replace("{}", plugin.displayName ?? plugin.name))
                    }
                }}
            >
                <ShieldIcon />
            </IconButton>

            <IconButton
                title={language.edit}
                onclick={(e) => {
                    e.stopPropagation()
                    openPluginScriptEditor(index, plugin)
                }}
            >
                <SquarePenIcon />
            </IconButton>

            <!--Also, remove button.-->
            <IconButton
                tone="destructive"
                onclick={async (e) => {
                    e.stopPropagation()
                    const v = await alertConfirm(
                        language.removeConfirm +
                            (plugin.displayName ?? plugin.name),
                    );
                    if (v) {
                        if (DBState.db.currentPluginProvider === plugin.name) {
                            DBState.db.currentPluginProvider = "";
                        }
                        let plugins = DBState.db.plugins ?? [];
                        plugins.splice(index, 1);
                        DBState.db.plugins = plugins;
                        loadPlugins()
                        void requestImmediateSave()
                    }
                }}
            >
                <TrashIcon />
            </IconButton>
            </IconButtonGroup>
        </div>
        {#if plugin.version === 1}
            <span class="text-draculared text-xs">
                {language.pluginVersionWarn
                    .replace("{{plugin_version}}", "API V1")
                    .replace("{{required_version}}", "API V3")}
            </span>
            <!--List up args-->
        {:else if Object.keys(plugin.arguments).filter((i) => !i.startsWith("hidden_")).length > 0 && showParams.includes(pluginKey(plugin, index))}
            <div class="flex flex-col mt-1 mb-2 bg-dark-900/50 p-3 rounded-md border border-darkborderc">
                {#each Object.keys(plugin.arguments) as arg}
                    {#if !arg.startsWith("hidden_")}
                        {#if typeof(plugin?.argMeta?.[arg]?.divider) === 'string'}
                            {#if plugin?.argMeta?.[arg]?.divider}
                                <div class="flex items-center mt-6">
                                    <div aria-hidden="true" class="w-full border-t border-darkborderc"></div>
                                    <div class="relative flex justify-center">
                                        <span class="px-2 text-sm text-textarea text-nowrap">{plugin?.argMeta?.[arg]?.divider}</span>
                                    </div>
                                    <div aria-hidden="true" class="w-full border-t border-darkborderc"></div>
                                </div>
                            {:else}
                                <div aria-hidden="true" class="w-full border-t border-darkborderc mt-6"></div>
                            {/if}
                        {/if}
                        <span class="mb-2 mt-6">{plugin?.argMeta?.[arg]?.name || arg}</span>
                        {#if plugin?.argMeta?.[arg]?.description}
                            <span class="mb-2 text-sm text-textcolor2">{plugin?.argMeta?.[arg]?.description}</span>
                        {/if}
                        {#if Array.isArray(plugin.arguments[arg])}
                            <SelectInput
                                className="mt-2 mb-4"
                                bind:value={
                                    DBState.db.plugins[index].realArg[arg] as string
                                }
                            >
                                {#each plugin.arguments[arg] as a}
                                    <OptionInput value={a}>{a}</OptionInput>
                                {/each}
                            </SelectInput>
                        {:else if plugin.arguments[arg] === "string"}

                            {#if plugin?.argMeta?.[arg]?.textarea}
                                <TextAreaInput
                                    className="mt-2"
                                    bind:value={
                                        DBState.db.plugins[index].realArg[arg] as string
                                    }
                                    placeholder={plugin?.argMeta?.[arg]?.placeholder}
                                />
                            {:else if plugin?.argMeta?.[arg]?.radio}
                                {#each plugin?.argMeta?.[arg]?.radio?.split(",") as radioOption}
                                    <CheckInput
                                        check={DBState.db.plugins[index].realArg[arg] === (radioOption.split('|').at(-1))}
                                        onChange={(e) => {
                                            if(e){
                                                DBState.db.plugins[index].realArg[arg] = (radioOption.split('|').at(-1))
                                            }
                                        }}
                                        margin={false}
                                        name={radioOption.split('|').at(0)}
                                    />
                                {/each}
                            {:else}
                                <TextInput
                                    className="mt-2"
                                    bind:value={
                                        DBState.db.plugins[index].realArg[arg] as string
                                    }
                                    placeholder={plugin?.argMeta?.[arg]?.placeholder}
                                />
                            {/if}
                        {:else if plugin.arguments[arg] === "int"}
                            {#if plugin?.argMeta?.[arg]?.checkbox}
                                <CheckInput
                                    check={DBState.db.plugins[index].realArg[arg] === '1'}
                                    onChange={(e) => {
                                        DBState.db.plugins[index].realArg[arg] = e ? '1' : '0'
                                    }}
                                    margin={false}
                                    name={
                                        plugin?.argMeta?.[arg]?.checkbox === '1' ? language.enable : plugin?.argMeta?.[arg]?.checkbox
                                    }
                                />
                            {:else if plugin?.argMeta?.[arg]?.radio}
                                {#each plugin?.argMeta?.[arg]?.radio?.split(",") as radioOption}
                                    <CheckInput
                                        check={DBState.db.plugins[index].realArg[arg] === parseInt(radioOption.split('|').at(-1))}
                                        onChange={(e) => {
                                            if(e){
                                                DBState.db.plugins[index].realArg[arg] = parseInt(radioOption.split('|').at(-1))
                                            }
                                        }}
                                        margin={false}
                                        name={radioOption.split('|').at(0)}
                                    />
                                {/each}
                            {:else}
                                <NumberInput
                                    className="mt-2"
                                    bind:value={
                                        DBState.db.plugins[index].realArg[arg] as number
                                    }
                                    placeholder={plugin?.argMeta?.[arg]?.placeholder}
                                />
                            {/if}
                        {/if}
                    {/if}
                {/each}
            </div>
        {/if}
    {/each}
    {#if DBState.db.plugins && DBState.db.plugins.length > 0}
        <div
            class="h-1 rounded-full transition-colors"
            class:bg-primary={isDraggingPlugin && dragOverPluginIndex === DBState.db.plugins.length}
            class:bg-transparent={!isDraggingPlugin || dragOverPluginIndex !== DBState.db.plugins.length}
            role="presentation"
            ondragover={(e) => {
                e.preventDefault()
                e.stopPropagation()
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
                dragOverPluginIndex = DBState.db.plugins.length
            }}
            ondrop={dropPlugin}
        ></div>
    {/if}
</div>

<span class="block text-draculared text-xs mt-4">{language.pluginWarn}</span>
{/snippet}

{#if embedded}
    {@render content()}
{:else}
    <SettingPage title={language.plugin}>
        {@render content()}
    </SettingPage>
{/if}
