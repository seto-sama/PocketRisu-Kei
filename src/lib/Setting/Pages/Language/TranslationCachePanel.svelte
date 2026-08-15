<script lang="ts">
    import { Collapsible } from 'bits-ui';
    import { ArrowDownUpIcon, ChevronDownIcon, CopyIcon, DownloadIcon, EraserIcon, HardDriveUploadIcon, LanguagesIcon, PencilIcon, ScrollTextIcon, SearchIcon, Trash2Icon } from '@lucide/svelte';
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import ShInput from "src/lib/UI/GUI/ShInput.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import SettingLayout from "src/lib/Setting/Wrappers/SettingLayout.svelte";
    import Help from "src/lib/Others/Help.svelte";
    import { language } from "src/lang";
    import { alertClear, alertConfirm, alertError, alertNormal, alertStore, alertWait, notifyError, notifySuccess } from "src/ts/alert";
    import { clearLLMCache, deleteLLMCache, exportLLMCacheAsJSON, importLLMCacheFromJSON, setLLMCache } from "src/ts/translator/translator";
    import { listLLMCacheEntries, loadLLMCacheEntriesInBackground } from "./translationCacheEntries";
    import { downloadFile } from "src/ts/globalApi.svelte";
    import { selectFileByDom } from "src/ts/util";
    import { getDatabase, type Chat, type Message } from "src/ts/storage/database.svelte";
    import { fetchChatFromServer } from "src/ts/storage/chatStorage";
    import { textAreaSize } from "src/ts/gui/guisize";

    type TranslationCacheEntry = {
        key: string;
        value: string;
    };

    const CACHE_PAGE_SIZE = 100;
    const cacheEditorHeight = $derived(`${(10 + $textAreaSize) * 2}rem`);

    let cacheAllEntries = $state<TranslationCacheEntry[]>([]);
    let cacheSearch = $state('');
    let cacheInitialized = $state(false);
    let cacheLoading = $state(false);
    let cacheLoadingMore = $state(false);
    let cacheHasMore = $state(false);
    let cacheNextOffset = $state(0);
    let cacheTotal = $state(0);
    let cacheLoadError = $state<string | null>(null);
    let expandedCacheEntries = $state<Record<string, boolean>>({});
    let originalVisibleCacheEntries = $state<Record<string, boolean>>({});
    let editingCacheKey = $state<string | null>(null);
    let editingCacheValue = $state('');
    let cacheLoadRequestId = 0;

    function resetTranslationCacheEditState() {
        editingCacheKey = null;
        editingCacheValue = '';
    }

    let filteredCacheEntries = $derived.by(() => {
        const normalizedSearch = cacheSearch.trim().toLowerCase();

        if (!normalizedSearch) {
            return cacheAllEntries;
        }

        return cacheAllEntries.filter((entry) => entry.key.toLowerCase().includes(normalizedSearch) || entry.value.toLowerCase().includes(normalizedSearch));
    });
    let displayedCacheEntries = $derived(filteredCacheEntries);
    let cacheIsPending = $derived(!cacheInitialized || cacheLoading);

    async function loadTranslationCacheEntries() {
        const requestId = ++cacheLoadRequestId;
        cacheInitialized = true;
        cacheLoading = true;
        cacheLoadError = null;
        try {
            const result = await listLLMCacheEntries({
                limit: CACHE_PAGE_SIZE,
            });
            if (requestId !== cacheLoadRequestId) {
                return;
            }
            cacheAllEntries = result.entries;
            cacheHasMore = result.hasMore;
            cacheNextOffset = result.nextOffset;
            cacheTotal = result.total;
        } catch (error) {
            if (requestId !== cacheLoadRequestId) {
                return;
            }
            cacheLoadError = error instanceof Error ? error.message : String(error);
        } finally {
            if (requestId === cacheLoadRequestId) {
                cacheLoading = false;
            }
        }
    }

    async function loadMoreTranslationCacheEntries() {
        if (cacheLoadingMore || !cacheHasMore) return;
        cacheLoadingMore = true;
        cacheLoadError = null;
        try {
            const result = await listLLMCacheEntries({
                limit: CACHE_PAGE_SIZE,
                offset: cacheNextOffset,
            });
            const existing = new Set(cacheAllEntries.map((entry) => entry.key));
            const fresh = result.entries.filter((entry) => !existing.has(entry.key));
            cacheAllEntries = [...cacheAllEntries, ...fresh];
            cacheHasMore = result.hasMore;
            cacheNextOffset = result.nextOffset;
            cacheTotal = result.total;
        } catch (error) {
            cacheLoadError = error instanceof Error ? error.message : String(error);
        } finally {
            cacheLoadingMore = false;
        }
    }

    async function copyTranslationCacheEntry(entry: TranslationCacheEntry) {
        try {
            await navigator.clipboard.writeText(`${entry.key}\n\n---\n\n${entry.value}`);
            notifySuccess(language.copied);
        } catch (error) {
            notifyError(error);
        }
    }

    async function deleteTranslationCacheEntry(entry: TranslationCacheEntry) {
        if (!(await alertConfirm(language.deleteTranslationCacheEntryConfirm))) {
            return;
        }

        try {
            await deleteLLMCache(entry.key);
            cacheAllEntries = cacheAllEntries.filter((cacheEntry) => cacheEntry.key !== entry.key);
            cacheNextOffset = Math.max(0, cacheNextOffset - 1);
            cacheTotal = Math.max(0, cacheTotal - 1);
            const nextExpanded = { ...expandedCacheEntries };
            delete nextExpanded[entry.key];
            expandedCacheEntries = nextExpanded;
            const nextOriginalVisible = { ...originalVisibleCacheEntries };
            delete nextOriginalVisible[entry.key];
            originalVisibleCacheEntries = nextOriginalVisible;
            notifySuccess(language.deleteTranslationCacheEntrySuccess);
            if (editingCacheKey === entry.key) {
                resetTranslationCacheEditState();
            }
        } catch (error) {
            notifyError(error);
        }
    }

    function openEditTranslationCacheEntry(entry: TranslationCacheEntry) {
        editingCacheKey = entry.key;
        editingCacheValue = entry.value;
    }

    function cancelEditTranslationCacheEntry() {
        resetTranslationCacheEditState();
    }

    async function saveEditingTranslationCacheEntry() {
        if (!editingCacheKey) {
            return;
        }

        try {
            const key = editingCacheKey;
            await setLLMCache(key, editingCacheValue);
            cacheAllEntries = cacheAllEntries.map((entry) => entry.key === key
                ? { ...entry, value: editingCacheValue }
                : entry);
            resetTranslationCacheEditState();
            await loadTranslationCacheEntries();
            notifySuccess(language.translationCacheEntrySaved);
        } catch (error) {
            notifyError(error);
        }
    }

    async function exportCache() {
        alertWait(language.loading);
        try {
            const cache = await exportLLMCacheAsJSON();
            if (Object.keys(cache).length === 0) {
                alertNormal(language.exportTranslationCacheEmpty);
                return;
            }
            await downloadFile("translation_cache.json", new TextEncoder().encode(JSON.stringify(cache, null, 2)));
            alertNormal(language.exportTranslationCacheSuccess);
        } catch (error: any) {
            alertError(error?.message ?? String(error));
        }
    }

    async function importCache() {
        try {
            const files = await selectFileByDom(["json"]);
            if (!files?.length || !files[0].name.endsWith(".json")) return;
            const data = JSON.parse(await files[0].text());
            if (typeof data !== "object" || data === null || Array.isArray(data)
                || Object.entries(data).some(([key, value]) => typeof key !== "string" || typeof value !== "string")) {
                alertError(language.invalidTranslationCacheFile);
                return;
            }
            if (!await alertConfirm(language.importTranslationCacheConfirm)) return;
            alertWait(language.loading);
            const { count, failed } = await importLLMCacheFromJSON(data);
            if (count > 0) await loadTranslationCacheEntries();
            if (failed) {
                alertError(language.importTranslationCacheFailed.replace("{0}", String(count)).replace("{1}", String(failed)));
            } else {
                alertNormal(language.importTranslationCacheSuccess.replace("{0}", String(count)));
            }
        } catch (error: any) {
            alertError(error?.message ?? String(error));
        }
    }

    async function clearCache() {
        if (!await alertConfirm(language.clearTranslationCacheConfirm)) return;
        alertWait(language.loading);
        try {
            await clearLLMCache();
            cacheAllEntries = [];
            cacheHasMore = false;
            cacheNextOffset = 0;
            cacheTotal = 0;
            expandedCacheEntries = {};
            originalVisibleCacheEntries = {};
            resetTranslationCacheEditState();
            alertNormal(language.clearTranslationCacheSuccess);
        } catch (error: any) {
            alertError(error?.message ?? String(error));
        }
    }

    async function getUsedTranslationCacheKeys(onProgress?: (current: number, total: number) => void) {
        const db = getDatabase();
        const usedKeys = new Set<string>();
        const total = (db.characters ?? []).reduce((sum, char) => sum + 1 + (char.alternateGreetings?.length ?? 0) + (char.chats?.length ?? 0), 0);
        let current = 0;
        const addRawTextKey = (text?: string | null) => {
            if (text?.trim()) usedKeys.add(text);
        };
        const progress = () => onProgress?.(++current, total);
        const getFullChat = async (chat: Chat, charId: string, chatIndex: number) => {
            if (!chat._placeholder) return chat;
            if (!chat.id) throw new Error(`Missing chat id while scanning ${charId} #${chatIndex}`);
            const fullChat = await fetchChatFromServer(charId, chatIndex, chat.id);
            if (!fullChat) throw new Error(`Failed to load chat while scanning ${charId}/${chat.id}`);
            return fullChat;
        };

        for (const char of db.characters ?? []) {
            const addMessageKey = (message: Message) => {
                if (message.data && !message.isComment) addRawTextKey(message.data);
            };
            addMessageKey({ role: "char", data: char.firstMessage });
            progress();
            for (const greeting of char.alternateGreetings ?? []) {
                addMessageKey({ role: "char", data: greeting });
                progress();
            }
            for (let chatIndex = 0; chatIndex < (char.chats?.length ?? 0); chatIndex++) {
                const fullChat = await getFullChat(char.chats[chatIndex], char.chaId, chatIndex);
                for (const message of fullChat.message ?? []) {
                    addMessageKey(message);
                    for (const swipe of message.swipes ?? []) addMessageKey({ ...message, data: swipe });
                }
                for (const summary of fullChat.hypaV3Data?.summaries ?? []) addRawTextKey(summary.text);
                progress();
            }
        }
        return usedKeys;
    }

    function setCleanupProgress(message: string, progress: number) {
        alertStore.set({
            type: "progress",
            msg: message,
            submsg: Math.max(0, Math.min(100, progress)).toFixed(1),
        });
    }

    async function cleanupUnusedCache() {
        if (!await alertConfirm(language.cleanupUnusedTranslationCacheConfirm)) return;
        try {
            setCleanupProgress(language.cleanupUnusedTranslationCacheProgressScanningChats, 0);
            const usedKeys = await getUsedTranslationCacheKeys((current, total) => {
                setCleanupProgress(language.cleanupUnusedTranslationCacheProgressScanningChats, total > 0 ? current / total * 35 : 35);
            });
            setCleanupProgress(language.cleanupUnusedTranslationCacheProgressLoadingCache, 35);
            const cache = await loadLLMCacheEntriesInBackground({
                onProgress: ({ entries, total }) => {
                    setCleanupProgress(language.cleanupUnusedTranslationCacheProgressLoadingCache, total > 0 ? 35 + entries.length / total * 35 : 70);
                },
            });
            const unusedEntries = cache.entries.filter((entry) => !usedKeys.has(entry.key));
            for (let index = 0; index < unusedEntries.length; index++) {
                setCleanupProgress(language.cleanupUnusedTranslationCacheProgressDeleting(index + 1, unusedEntries.length), 70 + (index + 1) / unusedEntries.length * 30);
                await deleteLLMCache(unusedEntries[index].key);
            }
            await loadTranslationCacheEntries();
            notifySuccess(language.cleanupUnusedTranslationCacheSuccess(unusedEntries.length));
        } catch (error) {
            notifyError(error);
        } finally {
            alertClear();
        }
    }

    $effect(() => {
        if (!cacheInitialized) {
            loadTranslationCacheEntries();
        }
    });
</script>

<div class="flex flex-col w-full">
    <SettingLayout variant="panel" className="mt-5">
        <div class="flex items-center gap-2 text-textcolor mb-3">
            <ArrowDownUpIcon size={16}/>
            <span class="font-medium">{language.translationCacheManagement}</span>
        </div>
        <p class="text-textcolor2 text-sm leading-relaxed mb-3">{language.translationCacheManagementDesc}</p>
        <div class="flex flex-col gap-3">
            {#each [
                { title: language.exportTranslationCache, desc: language.exportTranslationCacheDesc, icon: DownloadIcon, action: exportCache, variant: "outline" as const },
                { title: language.importTranslationCache, desc: language.importTranslationCacheDesc, icon: HardDriveUploadIcon, action: importCache, variant: "outline" as const },
                { title: language.cleanupUnusedTranslationCache, desc: language.cleanupUnusedTranslationCacheDesc, icon: EraserIcon, action: cleanupUnusedCache, variant: "outline" as const },
            ] as operation}
                <SettingLayout
                    variant="action"
                    title={operation.title}
                    description={operation.desc}
                    actionLabel={operation.title}
                    onAction={operation.action}
                    actionVariant={operation.variant}
                    actionIcon={operation.icon}
                />
            {/each}
        </div>
    </SettingLayout>
    <SettingLayout variant="panel" className="!mb-0">
        <div class="flex items-center gap-2 text-textcolor font-medium mb-3">
            <SearchIcon size={16} />
            <span>{language.translationCacheEntries}</span>
            <Help key="translationCacheSearchLimit" />
        </div>

        <SettingLayout variant="search">
            <ShInput bind:value={cacheSearch} placeholder={language.translationCacheSearchPlaceholder} />
                {#snippet control()}
                    <ShButton variant="destructive" size="default" onclick={clearCache} disabled={cacheLoading || cacheTotal === 0}>
                        <Trash2Icon />
                        {language.systemLogsClearAll}
                    </ShButton>
                {/snippet}
            </SettingLayout>

        <SettingLayout variant="status" shownCount={displayedCacheEntries.length} totalCount={cacheTotal} className="mt-3"
            loading={!cacheInitialized || cacheLoading} loadingLabel={language.loading} error={cacheLoadError} />

        {#if displayedCacheEntries.length > 0}
            <SettingLayout variant="list" scrollable>
                {#each displayedCacheEntries as entry (entry.key)}
                    <Collapsible.Root
                        open={expandedCacheEntries[entry.key] === true}
                        onOpenChange={(value) => { expandedCacheEntries = { ...expandedCacheEntries, [entry.key]: value } }}
                    >
                        <Collapsible.Trigger class="w-full text-left group">
                            <SettingLayout variant="item" className="gap-2 risu-interactive-surface group-focus-visible:bg-selected/30">
                            <span class="flex-1 min-w-0 truncate text-sm text-textcolor">{entry.key}</span>
                            <ChevronDownIcon size={16} class="shrink-0 text-textcolor2 transition-transform group-data-[state=open]:rotate-180" />
                            </SettingLayout>
                        </Collapsible.Trigger>

                        <Collapsible.Content class="bg-darkbg/60">
                            <div class="p-3 text-xs text-textcolor2 space-y-3">
                                {#if originalVisibleCacheEntries[entry.key]}
                                    <pre class="overflow-auto whitespace-pre-wrap break-all bg-bgcolor/50 border border-darkborderc/50 rounded px-4 py-2 text-textcolor font-mono" style:height={cacheEditorHeight}>{entry.key}</pre>
                                {/if}
                                {#if editingCacheKey === entry.key}
                                    <TextAreaInput
                                        bind:value={editingCacheValue}
                                        fullwidth
                                        actionBar={true}
                                        className="bg-bgcolor/50"
                                        contentClassName="font-mono whitespace-pre-wrap break-all"
                                        style={`height:${cacheEditorHeight};min-height:${cacheEditorHeight}`}
                                    />
                                {:else}
                                    <pre class="overflow-auto whitespace-pre-wrap break-all bg-bgcolor/50 border border-darkborderc/50 rounded px-4 py-2 text-textcolor font-mono" style:height={cacheEditorHeight}>{entry.value}</pre>
                                {/if}
                                <div class="flex items-center justify-between gap-2">
                                    <div class="flex flex-wrap gap-2">
                                        {#if editingCacheKey === entry.key}
                                            <ShButton variant="outline" size="sm" onclick={cancelEditTranslationCacheEntry}>
                                                <span>{language.cancel}</span>
                                            </ShButton>
                                            <ShButton variant="primary" size="sm" onclick={saveEditingTranslationCacheEntry}>
                                                <span>{language.editTranslationSave}</span>
                                            </ShButton>
                                        {:else}
                                            <ShButton variant="outline" size="sm" onclick={() => copyTranslationCacheEntry(entry)}>
                                                <CopyIcon />
                                                <span>{language.copy}</span>
                                            </ShButton>
                                            <ShButton variant="outline" size="sm" onclick={() => openEditTranslationCacheEntry(entry)}>
                                                <PencilIcon />
                                                <span>{language.edit}</span>
                                            </ShButton>
                                            <ShButton
                                                variant="outline"
                                                size="sm"
                                                onclick={() => {
                                                    originalVisibleCacheEntries = {
                                                        ...originalVisibleCacheEntries,
                                                        [entry.key]: !originalVisibleCacheEntries[entry.key],
                                                    };
                                                }}
                                            >
                                                <LanguagesIcon />
                                                <span>
                                                    {originalVisibleCacheEntries[entry.key]
                                                        ? language.translationCacheHideOriginal
                                                        : language.translationCacheShowOriginal}
                                                </span>
                                            </ShButton>
                                        {/if}
                                    </div>
                                    <div class="flex justify-end">
                                        <ShButton variant="destructive" size="sm" onclick={() => deleteTranslationCacheEntry(entry)}>
                                            <Trash2Icon />
                                            <span>{language.remove}</span>
                                        </ShButton>
                                    </div>
                                </div>
                            </div>
                        </Collapsible.Content>
                    </Collapsible.Root>
                {/each}
            </SettingLayout>
        {:else}
            <div class="flex flex-col items-center justify-center text-center py-16 bg-darkbg/30">
                <ScrollTextIcon size={48} class="text-textcolor2 mb-3 opacity-50" />
                <div class="text-textcolor font-medium mb-1">{cacheIsPending ? language.loading : cacheSearch.trim() ? language.noData : language.exportTranslationCacheEmpty}</div>
            </div>
        {/if}

        {#if cacheHasMore}
            <div class="flex justify-center mt-3">
                <ShButton variant="outline" size="default" disabled={cacheLoadingMore} onclick={loadMoreTranslationCacheEntries}>
                    {cacheLoadingMore ? language.systemLogsLoading : language.systemLogsLoadMore}
                </ShButton>
            </div>
        {/if}
    </SettingLayout>
</div>
