<script lang="ts">
    import { BookmarkIcon, LoaderCircleIcon } from '@lucide/svelte'
    import { onMount } from 'svelte'
    import { alertError } from 'src/ts/alert'
    import {
        collectGlobalBookmarks,
    } from 'src/ts/bookmarks/bookmarkData'
    import {
        assignBookmarkFolder,
        bookmarkCatalog,
        bookmarkCatalogLoading,
        bookmarkKey,
        deleteBookmark,
        ensureBookmarkCatalog,
        navigateToBookmark,
        renameBookmark,
        replaceBookmarkFolders,
    } from 'src/ts/bookmarks/bookmarkService'
    import type { GlobalBookmarkEntry } from 'src/ts/bookmarks/bookmarkTypes'
    import { language } from 'src/lang'
    import { bookmarkListOpen, DBState } from 'src/ts/stores.svelte'
    import InlineNameInput from '../UI/GUI/InlineNameInput.svelte'
    import PresetPickerActions from '../UI/PresetPickerActions.svelte'
    import PresetPickerLayout from '../UI/PresetPickerLayout.svelte'

    const close = () => $bookmarkListOpen = false
    let selectedFolder = $state('all')
    let searchQuery = $state('')
    let busyKey = $state('')
    let editMode = $state(false)

    const folders = $derived($bookmarkCatalog.folders)
    const bookmarks = $derived(collectGlobalBookmarks(DBState.db, $bookmarkCatalog))

    async function runBookmarkMutation(
        bookmark: GlobalBookmarkEntry,
        operation: () => Promise<void>,
    ) {
        const key = bookmarkKey(bookmark)
        if (busyKey) return
        busyKey = key
        try {
            await operation()
        }
        catch (error) {
            console.error('[bookmarks] Bookmark update failed', error)
            alertError(language.bookmarkOperationFailed)
        }
        finally {
            busyKey = ''
        }
    }

    function assignToFolder(index: number, folderId?: string) {
        const bookmark = bookmarks[index]
        if (!bookmark) return
        void runBookmarkMutation(bookmark, () => assignBookmarkFolder(bookmark, folderId))
    }

    async function commitName(index: number, value: string) {
        const bookmark = bookmarks[index]
        if (!bookmark) return
        const name = value.trim()
        if (!name || name === bookmark.name) return
        await runBookmarkMutation(bookmark, () => renameBookmark(bookmark, name))
    }

    function deleteBookmarkAt(index: number) {
        const bookmark = bookmarks[index]
        if (!bookmark) return
        void runBookmarkMutation(bookmark, () => deleteBookmark(bookmark))
    }

    async function goToBookmark(index: number) {
        const bookmark = bookmarks[index]
        if (!bookmark || busyKey) return
        busyKey = bookmarkKey(bookmark)
        try {
            if (await navigateToBookmark(bookmark)) close()
            else alertError(language.bookmarkTargetMissing)
        }
        catch (error) {
            console.error('[bookmarks] Bookmark navigation failed', error)
            alertError(language.bookmarkOperationFailed)
        }
        finally {
            busyKey = ''
        }
    }

    onMount(() => {
        void ensureBookmarkCatalog().catch(error => {
            console.error('[bookmarks] Catalog load failed', error)
            alertError(language.bookmarkOperationFailed)
        })
    })
</script>

<PresetPickerLayout
    title={language.bookmarks}
    {folders}
    itemFolderIds={bookmarks.map(bookmark => bookmark.folderId)}
    itemNames={bookmarks.map(bookmark => bookmark.name)}
    itemSearchTexts={bookmarks.map(bookmark =>
        `${bookmark.name} ${bookmark.characterName} ${bookmark.chatName}`
    )}
    itemDragDataKey="bookmarkIndex"
    bind:selectedFolder
    bind:searchQuery
    searchPlaceholder={language.bookmarkSearchPlaceholder}
    folderNamePrompt={language.bookmarkFolderNamePrompt}
    folderRenamePrompt={language.bookmarkFolderRenamePrompt}
    folderDeleteConfirm={language.bookmarkFolderDeleteConfirm}
    folderEmptyMessage={language.noBookmarks}
    noSearchResultsMessage={language.bookmarkNoSearchResults}
    allowFolderAssignmentDrag
    readOnly={!!busyKey}
    itemEditMode={editMode}
    {close}
    onFoldersChange={(next) => {
        void replaceBookmarkFolders(next).catch(error => {
            console.error('[bookmarks] Folder update failed', error)
            alertError(language.bookmarkOperationFailed)
        })
    }}
    onAssignItem={assignToFolder}
    onDeleteFolder={() => {}}
    onSelectItem={(index) => { void goToBookmark(index) }}
    onDeleteItem={deleteBookmarkAt}
>
    {#snippet itemContent(index)}
        {@const bookmark = bookmarks[index]}
        {#if bookmark}
            <BookmarkIcon class="mr-2 shrink-0" size={18} />
            {#if editMode}
                <div class="min-w-0 grow">
                    <InlineNameInput
                        value={bookmark.name}
                        size="default"
                        onchange={(event) => { void commitName(index, event.currentTarget.value) }}
                        onkeydown={(event) => {
                            if (event.key === 'Enter') event.currentTarget.blur()
                        }}
                    />
                </div>
            {:else}
                <div class="min-w-0 grow truncate">
                    <span>{bookmark.name}</span>
                    {#if bookmark.characterName}
                        <span class="text-textcolor2"> / {bookmark.characterName}</span>
                    {/if}
                    {#if bookmark.chatName}
                        <span class="text-textcolor2"> / {bookmark.chatName}</span>
                    {/if}
                </div>
            {/if}
            {#if busyKey === bookmarkKey(bookmark)}
                <LoaderCircleIcon class="ml-2 shrink-0 animate-spin text-textcolor2" size={18} />
            {/if}
        {/if}
    {/snippet}
    {#snippet listFooter()}
        {#if $bookmarkCatalogLoading}
            <div class="flex items-center justify-center gap-2 py-3 text-sm text-textcolor2">
                <LoaderCircleIcon class="animate-spin" size={16} />
                <span>{language.loading}</span>
            </div>
        {/if}
    {/snippet}

    <PresetPickerActions onRename={() => { editMode = !editMode }} />
</PresetPickerLayout>
