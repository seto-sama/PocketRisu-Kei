<script lang="ts">
    import { BookmarkIcon, LoaderCircleIcon } from '@lucide/svelte'
    import { onMount } from 'svelte'
    import { alertConfirm, alertError } from 'src/ts/alert'
    import {
        collectGlobalBookmarks,
    } from 'src/ts/bookmarks/bookmarkData'
    import {
        assignBookmarkTags,
        bookmarkCatalog,
        bookmarkCatalogLoading,
        bookmarkKey,
        deleteBookmark,
        ensureBookmarkCatalog,
        navigateToBookmark,
        renameBookmark,
        replaceBookmarkTags,
    } from 'src/ts/bookmarks/bookmarkService'
    import type { GlobalBookmarkEntry } from 'src/ts/bookmarks/bookmarkTypes'
    import { language } from 'src/lang'
    import { togglePresetTag } from 'src/ts/preset/tags'
    import { bookmarkListOpen, DBState } from 'src/ts/stores.svelte'
    import InlineEditableName from '../UI/components/InlineEditableName.svelte'
    import PresetPickerLayout from '../UI/PresetPickerLayout.svelte'

    const close = () => $bookmarkListOpen = false
    let selectedFolder = $state('all')
    let searchQuery = $state('')
    let busyKey = $state('')

    const tags = $derived($bookmarkCatalog.tags)
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

    function assignToTag(index: number, tagId?: string) {
        const bookmark = bookmarks[index]
        if (!bookmark) return
        void runBookmarkMutation(bookmark, () =>
            assignBookmarkTags(bookmark, togglePresetTag(bookmark.tagIds, tagId) ?? []))
    }

    async function commitName(index: number, value: string) {
        const bookmark = bookmarks[index]
        if (!bookmark) return
        const name = value.trim()
        if (!name || name === bookmark.name) return
        await runBookmarkMutation(bookmark, () => renameBookmark(bookmark, name))
    }

    async function deleteBookmarkAt(index: number) {
        const bookmark = bookmarks[index]
        if (!bookmark) return
        if (!await alertConfirm(`${language.removeConfirm}${bookmark.name}`)) return
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
    folders={tags}
    itemFolderIds={bookmarks.map(bookmark => bookmark.tagIds)}
    organizationKind="tag"
    itemNames={bookmarks.map(bookmark => bookmark.name)}
    itemSearchTexts={bookmarks.map(bookmark =>
        `${bookmark.name} ${bookmark.characterName} ${bookmark.chatName}`
    )}
    itemDragDataKey="bookmarkIndex"
    bind:selectedFolder
    bind:searchQuery
    searchPlaceholder={language.bookmarkSearchPlaceholder}
    folderNamePrompt={language.bookmarkTagNamePrompt}
    folderRenamePrompt={language.bookmarkTagRenamePrompt}
    folderDeleteConfirm={language.bookmarkTagDeleteConfirm}
    folderEmptyMessage={language.noBookmarks}
    allowFolderAssignmentDrag
    {close}
    onFoldersChange={(next) => {
        void replaceBookmarkTags(next).catch(error => {
            console.error('[bookmarks] Tag update failed', error)
            alertError(language.bookmarkOperationFailed)
        })
    }}
    onAssignItem={assignToTag}
    onDeleteFolder={() => {}}
    onSelectItem={(index) => { void goToBookmark(index) }}
    onDeleteItem={deleteBookmarkAt}
    itemDeleteLabel={language.bookmarkDeleteAction}
    itemRenameable
>
    {#snippet itemContent(index, renameController)}
        {@const bookmark = bookmarks[index]}
        {#if bookmark}
            <BookmarkIcon class="mr-2 shrink-0" size={18} />
            <InlineEditableName
                controller={renameController}
                value={bookmark.name}
                size="default"
                disabled={!!busyKey}
                onActivate={() => { void goToBookmark(index) }}
                onCommit={(value) => { void commitName(index, value) }}
            >
                {#snippet display()}
                    <span>{bookmark.name}</span>
                    {#if bookmark.characterName}
                        <span class="text-subtext"> / {bookmark.characterName}</span>
                    {/if}
                    {#if bookmark.chatName}
                        <span class="text-subtext"> / {bookmark.chatName}</span>
                    {/if}
                {/snippet}
            </InlineEditableName>
            {#if busyKey === bookmarkKey(bookmark)}
                <LoaderCircleIcon class="ml-2 shrink-0 animate-spin text-subtext" size={18} />
            {/if}
        {/if}
    {/snippet}
    {#snippet listFooter()}
        {#if $bookmarkCatalogLoading}
            <div class="flex items-center justify-center gap-2 py-3 text-sm text-subtext">
                <LoaderCircleIcon class="animate-spin" size={16} />
                <span>{language.loading}</span>
            </div>
        {/if}
    {/snippet}

</PresetPickerLayout>
