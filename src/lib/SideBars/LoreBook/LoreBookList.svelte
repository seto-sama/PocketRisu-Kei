<script lang="ts">
    import EmptyState from "src/lib/UI/components/EmptyState.svelte";
    import { language } from "src/lang";
    import { type loreBook } from "src/ts/storage/database.svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import LoreBookData from "./LoreBookData.svelte";
    import { selectedCharID } from "src/ts/stores.svelte";
    import Sortable from 'sortablejs/modular/sortable.core.esm.js';
    import { sortableOptions } from "src/ts/util";
    import { createEntityId } from 'src/ts/id';
    import DisclosureList from "../../UI/components/DisclosureList.svelte";
    import { restoreSortableDragOrigin, type SortableDragOrigin } from "../../UI/components/SortableList.svelte";
    import { reorderLoreBooks } from "./lorebookDrag";

    interface Props {
        submenu?: number;
        externalLoreBooks?: loreBook[];
        showFolder?: string;
        moduleMode?: boolean;
        openedRefs?: Set<loreBook>;
    }

    let {
        submenu = 0,
        externalLoreBooks = $bindable(null),
        showFolder = '',
        moduleMode = false,
        openedRefs = $bindable(new Set<loreBook>()),
    }: Props = $props();
    let ele: HTMLDivElement = $state()
    let sorted = $state(0)
    let idgroup = 'a' + createEntityId() //make should it starts with alphabetic character
    
    $effect(() => {
        if (!ele) return;
        let dragOrigin: SortableDragOrigin | null = null;
        const sortable = Sortable.create(ele, {
            ...sortableOptions,
            group: 'lorebook',        // Enable cross-container drag
            draggable: '[data-risu-idx]:not([data-risu-hidden])',
            filter: undefined,
            onMove: (event) => !(event.dragged.dataset.loreMode === 'folder' && event.to.dataset.showFolder),
            handle: '[data-disclosure-toggle]',
            swapThreshold: 0.9,      // More sensitive drag response
            animation: 150, // Animation
            chosenClass: "risu-chosen-item", // Class for the item being dragged
            dragClass: "risu-drag-item", // Class applied only after dragging starts
            ghostClass: "risu-ghost-item",  // Class for the drop placeholder

            onStart: (event) => {
                dragOrigin = { item: event.item, parent: event.from, nextSibling: event.item.nextSibling };
            },
            onEnd: (evt) => {
                
                if (evt.oldIndex === evt.newIndex && evt.from === evt.to) {
                    dragOrigin = null;
                    return;
                }

                // Select the correct data array based on component props and state
                let currentArray: loreBook[];
                if (externalLoreBooks) {
                    // Use externally passed lorebook array
                    currentArray = externalLoreBooks;
                } else if (submenu === 1) {
                    // Use local chat lorebook
                    currentArray = DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].localLore;
                } else {
                    // Use character global lorebook (default)
                    currentArray = DBState.db.characters[$selectedCharID].globalLore;
                }

                const newArray = reorderLoreBooks(evt.to, evt.item, currentArray);
                restoreSortableDragOrigin(dragOrigin);
                dragOrigin = null;
                if (!newArray) {
                    return;
                }

                if (externalLoreBooks) {
                    // Arrays passed as props must be modified internally to reflect in parent
                    externalLoreBooks.splice(0, externalLoreBooks.length, ...newArray);
                } else if (submenu === 1) {
                    DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].localLore = newArray;
                } else {
                    DBState.db.characters[$selectedCharID].globalLore = newArray;
                }
                
                // Rebind the list after Svelte renders its new rows.
                sorted += 1

            }
        });
        return () => {
            sortable.destroy();
            dragOrigin = null;
        };
    });

    function removeFromLoreBooks(lore: loreBook[], book: loreBook) {
        if (book.mode === 'folder') {
            lore.forEach(item => {
                if (item.folder === book.key && openedRefs.has(item)) {
                    onClose(true, item)
                }
            })

            const nextLore = lore.filter(item => item !== book && item.folder !== book.key)
            lore.splice(0, lore.length, ...nextLore)
            return
        }

        const idx = lore.indexOf(book)
        if (idx !== -1) {
            lore.splice(idx, 1)
        }
    }

    const onOpen = (_isDetail: boolean = true, bookRef?: any) => {
        if (bookRef) {
            openedRefs.add(bookRef)
            openedRefs = new Set(openedRefs) // Trigger reactivity
        }
    }
    const onClose = (_isDetail: boolean = true, bookRef?: any) => {
        if (bookRef) {
            openedRefs.delete(bookRef)
            openedRefs = new Set(openedRefs) // Trigger reactivity
        }
    }

</script>

{#key sorted}
    <DisclosureList
        appearance="row"
        className="{externalLoreBooks ? '' : 'mt-1'} {showFolder ? 'risu-tree-list' : ''}"
        bind:element={ele}
        data-show-folder={showFolder || ''}
    >
        {#if externalLoreBooks}
            {@const visibleItems = externalLoreBooks.filter(book => (!showFolder && !book.folder) || (showFolder === book.folder))}
            {@const lastVisibleItem = visibleItems[visibleItems.length - 1]}
            {#if visibleItems.length === 0}
                <EmptyState title={showFolder ? language.lorebookFolderEmpty : language.noLorebook} description="" layout="inline" />
            {/if}
            {#if externalLoreBooks.length > 0}
                {#each externalLoreBooks as book, i}
                    {#if (!showFolder && !book.folder) || (showFolder === book.folder)}
                        <LoreBookData idgroup={idgroup} bind:value={externalLoreBooks[i]} idx={i} {moduleMode} bind:openedRefs
                        isOpen={openedRefs.has(book)}
                        isLastInContainer={book === lastVisibleItem}
                        onRemove={() => {
                            if (openedRefs.has(book) && !book.folder) {
                                onClose(true, book)
                            }
                            else if(openedRefs.has(book) && book.folder){
                                onClose(false, book)
                            }
                            
                            removeFromLoreBooks(externalLoreBooks, book)
                            externalLoreBooks = externalLoreBooks
                        }} 
                        onOpen={(isDetail = true) => onOpen(isDetail, book)}
                        onClose={(isDetail = true) => onClose(isDetail, book)}
                        bind:externalLoreBooks={externalLoreBooks} />
                    {:else}
                        <!-- Hidden marker for filtered items (for SortableJS) -->
                        <div data-risu-idx={i} data-risu-idgroup={idgroup} data-risu-hidden="true" style="display: none;"></div>
                    {/if}
                {/each}
            {/if}
        {:else if submenu === 0}
            {@const visibleItems = DBState.db.characters[$selectedCharID].globalLore.filter(book => (!showFolder && !book.folder) || (showFolder === book.folder))}
            {@const lastVisibleItem = visibleItems[visibleItems.length - 1]}
            {#if visibleItems.length === 0}
                <EmptyState title={showFolder ? language.lorebookFolderEmpty : language.noLorebook} description="" layout="inline" />
            {/if}
            {#if DBState.db.characters[$selectedCharID].globalLore.length > 0}
                {#each DBState.db.characters[$selectedCharID].globalLore as book, i}
                    {#if (!showFolder && !book.folder) || (showFolder === book.folder)}
                        <LoreBookData idgroup={idgroup} bind:value={DBState.db.characters[$selectedCharID].globalLore[i]} idx={i} bind:openedRefs
                        isOpen={openedRefs.has(book)}
                        isLastInContainer={book === lastVisibleItem}
                        onRemove={() => {
                            if (openedRefs.has(book) && !book.folder) {
                                onClose(true, book)
                            }
                            else if(openedRefs.has(book) && book.folder){
                                onClose(false, book)
                            }
                            
                            let lore  = DBState.db.characters[$selectedCharID].globalLore
                            removeFromLoreBooks(lore, book)
                            DBState.db.characters[$selectedCharID].globalLore = lore
                        }} 
                        onOpen={(isDetail = true) => onOpen(isDetail, book)}
                        onClose={(isDetail = true) => onClose(isDetail, book)}
                        bind:externalLoreBooks={DBState.db.characters[$selectedCharID].globalLore}/>
                    {:else}
                        <!-- Hidden marker for filtered items (for SortableJS) -->
                        <div data-risu-idx={i} data-risu-idgroup={idgroup} data-risu-hidden="true" style="display: none;"></div>
                    {/if}
                {/each}
            {/if}
        {:else if submenu === 1}
            {@const visibleItems = DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].localLore.filter(book => (!showFolder && !book.folder) || (showFolder === book.folder))}
            {@const lastVisibleItem = visibleItems[visibleItems.length - 1]}
            {#if visibleItems.length === 0}
                <EmptyState title={showFolder ? language.lorebookFolderEmpty : language.noLorebook} description="" layout="inline" />
            {/if}
            {#if DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].localLore.length > 0}
                {#each DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].localLore as book, i}
                    {#if (!showFolder && !book.folder) || (showFolder === book.folder)}
                        <LoreBookData idgroup={idgroup} bind:value={DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].localLore[i]} idx={i} bind:openedRefs
                        isOpen={openedRefs.has(book)}
                        isLastInContainer={book === lastVisibleItem}
                        onRemove={() => {
                            if (openedRefs.has(book) && !book.folder) {
                                onClose(true, book)
                            }
                            else if(openedRefs.has(book) && book.folder){
                                onClose(false, book)
                            }
                            
                            let lore  = DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].localLore
                            removeFromLoreBooks(lore, book)
                            DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].localLore = lore
                        }} 
                        onOpen={(isDetail = true) => onOpen(isDetail, book)}
                        onClose={(isDetail = true) => onClose(isDetail, book)}
                        bind:externalLoreBooks={DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].localLore}/>
                    {:else}
                        <!-- Hidden marker for filtered items (for SortableJS) -->
                        <div data-risu-idx={i} data-risu-idgroup={idgroup} data-risu-hidden="true" style="display: none;"></div>
                    {/if}
                {/each}
            {/if}
        {/if}
    </DisclosureList>
{/key}
