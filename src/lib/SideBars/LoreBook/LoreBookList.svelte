<script lang="ts">
    import { type loreBook } from "src/ts/storage/database.svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import LoreBookData from "./LoreBookData.svelte";
    import { selectedCharID } from "src/ts/stores.svelte";
    import Sortable from 'sortablejs/modular/sortable.core.esm.js';
    import { onDestroy, onMount, tick } from "svelte";
    import { sleep, sortableOptions } from "src/ts/util";
    import { v4 } from "uuid";
    import { notifyError } from "src/ts/alert";
    import ShDisclosureList from "src/lib/UI/GUI/ShDisclosureList.svelte";

    let reinitializeSortable = false;

    interface Props {
        submenu?: number;
        externalLoreBooks?: loreBook[];
        showFolder?: string;
        moduleMode?: boolean;
        openedRefs?: Set<loreBook>;
        listEditMode?: boolean;
    }

    let {
        submenu = 0,
        externalLoreBooks = $bindable(null),
        showFolder = '',
        moduleMode = false,
        openedRefs = $bindable(new Set<loreBook>()),
        listEditMode = $bindable(false),
    }: Props = $props();
    let stb: Sortable = null
    let ele: HTMLDivElement = $state()
    let sorted = $state(0)
    let idgroup = 'a' + v4() //make should it starts with alphabetic character
    
    // DOM stabilization waiting function
    const waitForDOMReady = async () => {
        // 1. Wait for Svelte tick - component state update completion
        await tick();
        
        // 2. Wait for next frame - DOM rendering completion
        await new Promise(resolve => requestAnimationFrame(resolve));
        
        // 3. Element validity verification
        if (!ele || !ele.isConnected) {
            await new Promise(resolve => setTimeout(resolve, 50));
            if (!ele || !ele.isConnected) {
                throw new Error('Container element is not ready');
            }
        }
        
        // 4. Calculate expected number of child elements
        let expectedElements = 0;
        if (externalLoreBooks) {
            expectedElements = externalLoreBooks.filter(item => 
                (!showFolder && !item.folder) || (showFolder === item.folder)
            ).length;
        } else if (submenu === 1) {
            expectedElements = DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].localLore.filter(item => 
                (!showFolder && !item.folder) || (showFolder === item.folder)
            ).length;
        } else {
            expectedElements = DBState.db.characters[$selectedCharID].globalLore.filter(item => 
                (!showFolder && !item.folder) || (showFolder === item.folder)
            ).length;
        }
        
        // 5. Wait until all child elements are rendered (max 200ms)
        let attempts = 0;
        const maxAttempts = 20;
        while (ele.children.length < expectedElements && attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 10));
            attempts++;
        }
        
        // 6. Final stabilization wait (short time)
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    
    // SortableJS recreation function
    const recreateStb = async () => {
        try {
            stb.destroy()
        } catch (error) {
            // Ignore destroy failure (may already be removed)
        }

        // Svelte reactivity trigger - force re-render {#key} block by changing sorted value
        sorted += 1

        // Wait for DOM stabilization (dynamic measurement)
        try {
            await waitForDOMReady();
        } catch (error) {
            console.warn('DOM stabilization failed:', error);
            // Fallback to short fixed wait
            await sleep(100);
        }
        
        try {
            createStb(); // Create new SortableJS instance
        } catch (error) {
            console.error('Failed to recreate sortable:', error);
            // Retry
            await sleep(50);
            try {
                createStb();
            } catch (retryError) {
                console.error('Retry failed:', retryError);
            }
        }
    }
    
    const createStb = () => {
        stb = Sortable.create(ele, {
            ...sortableOptions,
            group: 'lorebook',        // Enable cross-container drag
            draggable: '[data-risu-idx]:not([data-risu-hidden]), [data-risu-drop-index]',
            handle: '[data-disclosure-toggle]',
            swapThreshold: 0.9,      // More sensitive drag response
            preventOnFilter: false, // Allow click events on filtered elements
            animation: 150, // Animation
            chosenClass: "risu-chosen-item", // Class for the item being dragged
            dragClass: "risu-drag-item", // Class applied only after dragging starts
            ghostClass: "risu-ghost-item",  // Class for the drop placeholder

            onEnd: async (evt) => {
                
                // Basic condition check
                if (!evt.from || !evt.to) {
                    notifyError('Error: \'evt.from\' or \'evt.to\' is null');
                    await recreateStb();
                    return;
                }
                
                // Cancel movement
                if (evt.oldIndex === evt.newIndex && evt.from === evt.to) {
                    await recreateStb();
                    return;
                }

                // ===== Stage 1: Collect drag event information =====
                // Identify source and target folders (using data-show-folder attribute)
                const sourceFolder = evt.from.getAttribute('data-show-folder') || '';
                const targetFolder = evt.to.getAttribute('data-show-folder') || '';
                
                // ===== Stage 2: Identify current data array =====
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

                const sourceIdx = Number.parseInt(evt.item.getAttribute('data-risu-idx') ?? '', 10);
                let realSourceIdx = sourceIdx;

                // Abort if invalid index (0 is valid index, so check !== undefined)
                if (evt.item.hasAttribute('data-risu-drop-index') || !Number.isInteger(realSourceIdx) || realSourceIdx < 0) {
                    await recreateStb();
                    return;
                }
                const movedItem = currentArray[realSourceIdx]; // Actual item to move
                if (!movedItem) {
                    await recreateStb();
                    return;
                }

                // ===== Stage 4: Array reconstruction and data application (improved logic) =====

                // 4-1. Copy the array while preserving the moved item's identity.
                const newArray = [...currentArray]; // Copy array
                const updatedMovedItem = movedItem;

                // 4-2. Change folder property of copied item
                if (sourceFolder !== targetFolder) {
                    if (targetFolder) {
                        updatedMovedItem.folder = targetFolder;

                    } else {
                        delete updatedMovedItem.folder;
                    }
                }

                // 4-3-1. Move item in array using its original data index.
                // First remove original item from array
                
                newArray.splice(realSourceIdx, 1);

                // Insert updated item at new position, based on the actual drop DOM order.
                const adjustedFinalIndex = getDropInsertIndex(evt, currentArray, newArray, targetFolder);

                // SortableJS automatically manipulates DOM upon drag completion,
                // but Svelte uses data-driven rendering, so DOM manipulation must be invalidated.
                revertSortableDomMove(evt);

                newArray.splice(adjustedFinalIndex, 0, updatedMovedItem);

                // 4-3-2. Reorganize entire array according to folder structure
                const sortedArray = [];
                const processedItems = new Set();
                
                // Maintain basic order while organizing folder structure only
                for (const item of newArray) {
                    if (processedItems.has(item)) continue;
                    
                    // Add current item first (whether folder or regular item)
                    sortedArray.push(item);
                    processedItems.add(item);
                    
                    // If current item is a folder, add items belonging to that folder immediately after
                    if (item.mode === 'folder') {
                        for (const subItem of newArray) {
                            if (processedItems.has(subItem)) continue;
                            if (subItem.folder === item.key) {
                                sortedArray.push(subItem);
                                processedItems.add(subItem);
                            }
                        }
                    }
                }
                
                // Assign final sorted array to newArray
                newArray.splice(0, newArray.length, ...sortedArray);

                // 4-4. Apply final changed array to appropriate data store
                if (externalLoreBooks) {
                    // Arrays passed as props must be modified internally to reflect in parent
                    externalLoreBooks.splice(0, externalLoreBooks.length, ...newArray);
                } else if (submenu === 1) {
                    DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].localLore = newArray;
                } else {
                    DBState.db.characters[$selectedCharID].globalLore = newArray;
                }
                
                // ===== Stage 5: Force UI synchronization and SortableJS reinitialization =====
                // Remove existing SortableJS instance (prevent DOM inconsistency due to data change)
                await recreateStb()

            }
        })
    }

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

    function isShownInFolder(item: loreBook, folder: string) {
        return (!folder && !item.folder) || folder === item.folder
    }

    function getDirectLoreElements(container: HTMLElement) {
        return Array.from(container.children).filter((child): child is HTMLElement =>
            child instanceof HTMLElement &&
            (child.hasAttribute('data-risu-idx') || child.hasAttribute('data-risu-drop-index')) &&
            !child.hasAttribute('data-risu-hidden')
        )
    }

    function getFolderEndIndex(items: loreBook[], folder: loreBook) {
        let idx = items.indexOf(folder)
        if (idx === -1) return -1
        if (folder.mode !== 'folder') return idx

        while (idx + 1 < items.length && items[idx + 1].folder === folder.key) {
            idx += 1
        }
        return idx
    }

    function revertSortableDomMove(evt: Sortable.SortableEvent) {
        const originalParent = evt.from
        const originalIndex = evt.oldIndex
        if (!originalParent || originalIndex === undefined || evt.item.parentNode === originalParent) {
            return
        }

        const referenceNode = originalParent.children[originalIndex]
        if (referenceNode) {
            originalParent.insertBefore(evt.item, referenceNode)
        } else {
            originalParent.appendChild(evt.item)
        }
    }

    function getDropInsertIndex(evt: Sortable.SortableEvent, beforeMove: loreBook[], afterRemoval: loreBook[], targetFolder: string) {
        const target = evt.to as HTMLElement
        const targetItems = getDirectLoreElements(target)
        const movedPosition = targetItems.indexOf(evt.item as HTMLElement)
        const nextElement = targetItems.slice(movedPosition + 1).find(child => child !== evt.item)
        const previousElement = targetItems.slice(0, movedPosition).reverse().find(child => child !== evt.item)

        const explicitTarget = getExplicitDropIndex(evt.item as HTMLElement, afterRemoval)
        if (explicitTarget !== null) {
            return explicitTarget
        }

        if (nextElement) {
            const explicitNext = getExplicitDropIndex(nextElement, afterRemoval)
            if (explicitNext !== null) {
                return explicitNext
            }

            const nextIdx = Number.parseInt(nextElement.getAttribute('data-risu-idx') ?? '', 10)
            const nextItem = beforeMove[nextIdx]
            const insertIdx = afterRemoval.indexOf(nextItem)
            return insertIdx === -1 ? afterRemoval.length : insertIdx
        }

        if (previousElement) {
            const explicitPrevious = getExplicitDropIndex(previousElement, afterRemoval)
            if (explicitPrevious !== null) {
                return explicitPrevious
            }

            const previousIdx = Number.parseInt(previousElement.getAttribute('data-risu-idx') ?? '', 10)
            const previousItem = beforeMove[previousIdx]
            const previousEndIdx = getFolderEndIndex(afterRemoval, previousItem)
            return previousEndIdx === -1 ? afterRemoval.length : previousEndIdx + 1
        }

        if (targetFolder) {
            const parentFolder = afterRemoval.find(item => item.mode === 'folder' && item.key === targetFolder)
            const parentIdx = parentFolder ? afterRemoval.indexOf(parentFolder) : -1
            return parentIdx === -1 ? afterRemoval.length : parentIdx + 1
        }

        const firstRootItem = afterRemoval.find(item => isShownInFolder(item, ''))
        const firstRootIdx = firstRootItem ? afterRemoval.indexOf(firstRootItem) : -1
        return firstRootIdx === -1 ? afterRemoval.length : firstRootIdx
    }

    function getExplicitDropIndex(element: HTMLElement, items: loreBook[]) {
        const attr = element.getAttribute('data-risu-drop-index')
        if (attr === null) return null

        const idx = Number.parseInt(attr, 10)
        if (!Number.isInteger(idx)) return items.length
        return Math.max(0, Math.min(idx, items.length))
    }

    function getDropIndexBefore(book: loreBook, lore: loreBook[]) {
        const idx = lore.indexOf(book)
        return idx === -1 ? lore.length : idx
    }

    function getDropIndexAfter(book: loreBook, lore: loreBook[]) {
        const endIdx = getFolderEndIndex(lore, book)
        return endIdx === -1 ? lore.length : endIdx + 1
    }

    function getStartDropIndex(lore: loreBook[]) {
        if (showFolder) {
            const folder = lore.find(item => item.mode === 'folder' && item.key === showFolder)
            const idx = folder ? lore.indexOf(folder) : -1
            return idx === -1 ? lore.length : idx + 1
        }

        const firstRootItem = lore.find(item => isShownInFolder(item, ''))
        const idx = firstRootItem ? lore.indexOf(firstRootItem) : -1
        return idx === -1 ? lore.length : idx
    }


    onMount(createStb)

    // Derived state to calculate number of open folders
    let openFolders = $derived(() => {
        let count = 0
        for (const ref of openedRefs) {
            if (ref && typeof ref === 'object' && 'mode' in ref && ref.mode === 'folder') {
                count++
            }
        }
        return count
    })
    
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

    onDestroy(() => {
        if(stb){
            try {
                stb.destroy()
            } catch (error) {  }
        }
    })
</script>

{#key sorted}
    <ShDisclosureList
        className={externalLoreBooks ? '' : 'mt-2'}
        background={!externalLoreBooks}
        bind:element={ele}
        data-show-folder={showFolder || ''}
    >
        {#if externalLoreBooks}
            {@const visibleItems = externalLoreBooks.filter(book => (!showFolder && !book.folder) || (showFolder === book.folder))}
            {@const lastVisibleItem = visibleItems[visibleItems.length - 1]}
            {#if visibleItems.length === 0}
                <div class="lorebook-drop-pad" data-risu-drop-index={getStartDropIndex(externalLoreBooks)} aria-hidden="true"></div>
            {/if}
            {#if externalLoreBooks.length === 0}
                <span class="text-textcolor2">No Lorebook</span>
            {:else}
                {#each externalLoreBooks as book, i}
                    {#if (!showFolder && !book.folder) || (showFolder === book.folder)}
                        <div class="lorebook-drop-pad" data-risu-drop-index={getDropIndexBefore(book, externalLoreBooks)} aria-hidden="true"></div>
                        <LoreBookData idgroup={idgroup} bind:value={externalLoreBooks[i]} idx={i} {moduleMode} bind:openedRefs bind:listEditMode
                        isOpen={openedRefs.has(book)}
                        openFolders={openFolders()}
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
                        {#if book === lastVisibleItem}
                            <div class="lorebook-drop-pad" data-risu-drop-index={getDropIndexAfter(book, externalLoreBooks)} aria-hidden="true"></div>
                        {/if}
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
                <div class="lorebook-drop-pad" data-risu-drop-index={getStartDropIndex(DBState.db.characters[$selectedCharID].globalLore)} aria-hidden="true"></div>
            {/if}
            {#if DBState.db.characters[$selectedCharID].globalLore.length === 0}
                <span class="text-textcolor2">No Lorebook</span>
            {:else}
                {#each DBState.db.characters[$selectedCharID].globalLore as book, i}
                    {#if (!showFolder && !book.folder) || (showFolder === book.folder)}
                        <div class="lorebook-drop-pad" data-risu-drop-index={getDropIndexBefore(book, DBState.db.characters[$selectedCharID].globalLore)} aria-hidden="true"></div>
                        <LoreBookData idgroup={idgroup} bind:value={DBState.db.characters[$selectedCharID].globalLore[i]} idx={i} bind:openedRefs bind:listEditMode
                        isOpen={openedRefs.has(book)}
                        openFolders={openFolders()}
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
                        {#if book === lastVisibleItem}
                            <div class="lorebook-drop-pad" data-risu-drop-index={getDropIndexAfter(book, DBState.db.characters[$selectedCharID].globalLore)} aria-hidden="true"></div>
                        {/if}
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
                <div class="lorebook-drop-pad" data-risu-drop-index={getStartDropIndex(DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].localLore)} aria-hidden="true"></div>
            {/if}
            {#if DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].localLore.length === 0}
                <span class="text-textcolor2">No Lorebook</span>
            {:else}
                {#each DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].localLore as book, i}
                    {#if (!showFolder && !book.folder) || (showFolder === book.folder)}
                        <div class="lorebook-drop-pad" data-risu-drop-index={getDropIndexBefore(book, DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].localLore)} aria-hidden="true"></div>
                        <LoreBookData idgroup={idgroup} bind:value={DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].localLore[i]} idx={i} bind:openedRefs bind:listEditMode
                        isOpen={openedRefs.has(book)}
                        openFolders={openFolders()}
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
                        {#if book === lastVisibleItem}
                            <div class="lorebook-drop-pad" data-risu-drop-index={getDropIndexAfter(book, DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].localLore)} aria-hidden="true"></div>
                        {/if}
                    {:else}
                        <!-- Hidden marker for filtered items (for SortableJS) -->
                        <div data-risu-idx={i} data-risu-idgroup={idgroup} data-risu-hidden="true" style="display: none;"></div>
                    {/if}
                {/each}
            {/if}
        {/if}
    </ShDisclosureList>
{/key}

<style>
    .lorebook-drop-pad {
        min-height: 0.75rem;
        flex: 0 0 0.75rem;
        margin-block: -0.375rem;
        position: relative;
        z-index: 1;
    }
</style>
