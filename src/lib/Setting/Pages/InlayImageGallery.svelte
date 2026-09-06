<script lang="ts">
    import EmptyState from "src/lib/UI/components/EmptyState.svelte";
  import { onDestroy, untrack } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import { AudioLinesIcon, CopyIcon, DownloadIcon, LoaderCircleIcon, Trash2Icon, VideoIcon } from '@lucide/svelte'
  import SelectOption from "../../UI/components/SelectOption.svelte";
  import Checkbox from '../../UI/components/Checkbox.svelte'
  import Button from '../../UI/components/Button.svelte'
  import Select from '../../UI/components/Select.svelte'

  import { language } from 'src/lang'
  import { InlayGallerySubmenuIndex } from 'src/ts/stores.svelte'
  import { alertConfirm, notifyError } from 'src/ts/alert'
  import {
    getCharacterChatIndex,
    getInlayAssetUrl,
    getInlayThumbnailUrl,
    getInlayVideoThumbnailUrl,
    listInlayExplorerItems,
    removeInlayAsset,
    scanInlayReferences,
    type CharacterChatIndexItem,
    type InlayExplorerItem,
    type InlayScanResult,
  } from 'src/ts/process/files/inlays'
  import SettingPage from '../../UI/components/SettingPage.svelte'
  import SettingLayout from '../Wrappers/SettingLayout.svelte'
  import SettingTabs from '../../UI/components/SettingTabs.svelte'
  import SettingRenderer from '../SettingRenderer.svelte'
  import { inlayImageSettingsItems } from 'src/ts/setting/inlayImageSettingsData'
  import FullscreenImageViewer from '../../UI/components/FullscreenImageViewer.svelte'
  import IconButton from '../../UI/components/IconButton.svelte'
  import AssetViewerActions from '../../UI/components/AssetViewerActions.svelte'
  import InlayViewerMetadata from '../../UI/components/InlayViewerMetadata.svelte'
  import { createIncrementalList } from '../../UI/incrementalList.svelte'
  import { copyInlayReference, downloadInlayAsset } from '../../UI/inlayViewerActions'
  import { isEventFromInteractiveChild } from 'src/lib/utils'

  type SortKey = 'created-desc' | 'created-asc' | 'updated-desc' | 'updated-asc'
  type SpecialFilter = 'all' | 'meta-missing' | 'orphan-character' | 'orphan-chat' | 'orphan-message'

  // Data state
  let allItems = $state<InlayExplorerItem[]>([])
  let characterIndex = $state<CharacterChatIndexItem[]>([])
  let loading = $state(true)
  let galleryScrollContainer: HTMLDivElement | null = $state(null)
  let selection = $state<Set<string>>(new SvelteSet())
  let failedVideoThumbnails = $state<Set<string>>(new SvelteSet())

  // Filter/sort state
  let sortKey = $state<SortKey>('updated-desc')
  let characterFilter = $state('')
  let chatFilter = $state('')
  let specialFilter = $state<SpecialFilter>('all')
  let filtersOpen = $state(false)

  // Scan state
  let scanResult = $state<InlayScanResult | null>(null)
  let scanning = $state(false)
  let scanError = $state('')
  let scanSequence = 0

  // Viewer state
  let viewerOpen = $state(false)
  let viewerId = $state('')
  let viewerUrl = $state('')
  let viewerLoading = $state(false)
  let viewerError = $state('')
  let deletingAsset = $state(false)
  const incrementalList = createIncrementalList({
    pageSize: 40,
    rootMargin: '200px 0px',
    getRoot: () => findGalleryScrollRoot(),
  })
  const observePagingSentinel = incrementalList.observeSentinel

  // --- Derived ---
  const activeFilterCount = $derived(
    (characterFilter !== '' ? 1 : 0) +
    (chatFilter !== '' ? 1 : 0) +
    (specialFilter !== 'all' ? 1 : 0)
  )
  const characterMap = $derived(new Map(characterIndex.map((char) => [char.chaId, char])))
  const allChatIds = $derived(new Set(characterIndex.flatMap((char) => char.chats.map((chat) => chat.id))))
  const availableChats = $derived(characterFilter ? (characterMap.get(characterFilter)?.chats ?? []) : [])
  const tabItems = $derived(allItems.filter((item) => $InlayGallerySubmenuIndex === 0
    ? item.type === 'image'
    : item.type === 'video' || item.type === 'audio'))

  const filteredItems = $derived.by(() => {
    return tabItems
      .filter((item) => {
        if (characterFilter && item.meta?.charId !== characterFilter) return false
        if (chatFilter && item.meta?.chatId !== chatFilter) return false
        if (specialFilter === 'meta-missing' && item.hasMeta) return false
        if (specialFilter === 'orphan-character' && !isOrphanCharacter(item)) return false
        if (specialFilter === 'orphan-chat' && !isOrphanChat(item)) return false
        if (specialFilter === 'orphan-message' && (!scanResult || scanning || (scanResult.refCounts[item.id] ?? 0) > 0)) return false
        return true
      })
  })

  const sortedItems = $derived.by(() => {
    return [...filteredItems].sort((left, right) => {
      const leftValue = getSortTimestamp(left, sortKey)
      const rightValue = getSortTimestamp(right, sortKey)
      return sortKey.endsWith('asc') ? leftValue - rightValue : rightValue - leftValue
    })
  })

  const displayedItems = $derived(incrementalList.slice(sortedItems))
  const hasMore = $derived(incrementalList.hasMore(sortedItems.length))
  const hasSelection = $derived(selection.size > 0)
  const currentViewerItem = $derived(sortedItems.find((item) => item.id === viewerId) ?? null)
  const viewerIndex = $derived(sortedItems.findIndex((item) => item.id === viewerId))
  const canGoPrev = $derived(viewerIndex >= 0 && sortedItems.length > 1)
  const canGoNext = $derived(viewerIndex >= 0 && sortedItems.length > 1)

  // --- Helpers ---
  function getSortTimestamp(item: InlayExplorerItem, key: SortKey): number {
    if (key.startsWith('created')) return item.meta?.createdAt ?? 0
    return item.meta?.updatedAt ?? 0
  }

  function findGalleryScrollRoot(): HTMLElement | null {
    let element = galleryScrollContainer?.parentElement ?? null
    while (element) {
      const overflowY = getComputedStyle(element).overflowY
      if ((overflowY === 'auto' || overflowY === 'scroll') && element.scrollHeight > element.clientHeight) {
        return element
      }
      element = element.parentElement
    }
    return null
  }

  function getCharacterName(item: InlayExplorerItem | null): string | null {
    const charId = item?.meta?.charId
    if (!charId) return null
    return characterMap.get(charId)?.name ?? null
  }

  function getChatName(item: InlayExplorerItem | null): string | null {
    const charId = item?.meta?.charId
    const chatId = item?.meta?.chatId
    if (!chatId) return null
    if (charId) {
      const chat = characterMap.get(charId)?.chats.find((entry) => entry.id === chatId)
      return chat?.name ?? null
    }
    for (const char of characterIndex) {
      const chat = char.chats.find((entry) => entry.id === chatId)
      if (chat) return chat.name
    }
    return null
  }

  function isOrphanCharacter(item: InlayExplorerItem): boolean {
    const charId = item.meta?.charId
    return !!charId && !characterMap.has(charId)
  }

  function isOrphanChat(item: InlayExplorerItem): boolean {
    const chatId = item.meta?.chatId
    if (!chatId) return false
    const charId = item.meta?.charId
    if (charId) {
      const char = characterMap.get(charId)
      if (!char) return false
      return !char.chats.some((chat) => chat.id === chatId)
    }
    return !allChatIds.has(chatId)
  }

  function getStatusLabel(item: InlayExplorerItem | null): string | null {
    if (!item) return null
    if (!item.hasMeta) return language.inlayGallery.inlayFilterMetaMissing
    if (isOrphanCharacter(item)) return language.inlayGallery.inlayFilterOrphanCharacter
    if (isOrphanChat(item)) return language.inlayGallery.inlayFilterOrphanChat
    return null
  }

  function revokeViewerUrl() {
    viewerUrl = ''
  }

  function loadViewerAsset(id: string) {
    revokeViewerUrl()
    viewerLoading = false
    viewerError = ''
    // Use direct /api/asset/ URL — browser handles caching via HTTP headers
    viewerUrl = getInlayAssetUrl(id)
  }

  function openViewer(id: string) {
    viewerOpen = true
    viewerId = id
    loadViewerAsset(id)
  }

  function handleCardClick(event: MouseEvent, id: string) {
    if (isEventFromInteractiveChild(event)) return
    openViewer(id)
  }

  function handleCardKeydown(event: KeyboardEvent, id: string) {
    if (event.target !== event.currentTarget) return
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    openViewer(id)
  }

  function closeViewer() {
    viewerOpen = false
    viewerId = ''
    viewerError = ''
    viewerLoading = false
    revokeViewerUrl()
  }

  function goToNeighbor(offset: -1 | 1) {
    if (viewerIndex < 0 || sortedItems.length < 2) return
    const nextIndex = (viewerIndex + offset + sortedItems.length) % sortedItems.length
    const nextItem = sortedItems[nextIndex]
    openViewer(nextItem.id)
  }

  const toggleSelect = (id: string) => {
    if (selection.has(id)) selection.delete(id)
    else selection.add(id)
  }

  const selectAll = () => {
    if (!scanning && !deletingAsset) displayedItems.forEach((item) => selection.add(item.id))
  }
  const deselectAll = () => selection.clear()

  const deleteAsset = async (id: string, name: string) => {
    if (deletingAsset || scanning) return
    deletingAsset = true
    try {
      const protectReferences = specialFilter === 'orphan-message'
      if (!(await alertConfirm(language.inlayGallery.inlayDeleteConfirm.replace('{name}', name)))) return
      if (protectReferences) {
        const result = await refreshReferenceScan()
        if ((result.refCounts[id] ?? 0) > 0) {
          selection.delete(id)
          return
        }
      }
      const currentIndex = sortedItems.findIndex((item) => item.id === id)
      const neighborId = currentIndex >= 0
        ? (sortedItems[currentIndex + 1] ?? sortedItems[currentIndex - 1])?.id
        : undefined
      await removeInlayAsset(id)
      selection.delete(id)
      allItems = allItems.filter((item) => item.id !== id)
      if (viewerId === id) {
        if (neighborId) openViewer(neighborId)
        else closeViewer()
      }
    } catch (error) {
      notifyError(error)
    } finally {
      deletingAsset = false
    }
  }

  const deleteSelected = async () => {
    if (selection.size === 0 || deletingAsset || scanning) return
    deletingAsset = true
    const protectReferences = specialFilter === 'orphan-message'
    const ids = allItems.filter((item) => selection.has(item.id)).map((item) => item.id)
    try {
      if (!(await alertConfirm(language.inlayGallery.inlayDeleteMultipleConfirm.replace('{count}', ids.length.toString())))) return
      const references = protectReferences ? await refreshReferenceScan() : null
      for (const id of ids) {
        if (references && (references.refCounts[id] ?? 0) > 0) {
          selection.delete(id)
          continue
        }
        await removeInlayAsset(id)
        allItems = allItems.filter((item) => item.id !== id)
        selection.delete(id)
        if (viewerId === id) closeViewer()
      }
    } catch (error) {
      notifyError(error)
    } finally {
      deletingAsset = false
    }
  }

  async function refreshReferenceScan() {
    const sequence = ++scanSequence
    scanning = true
    scanError = ''
    scanResult = null
    try {
      const result = await scanInlayReferences(allItems.map(item => item.id))
      if (sequence === scanSequence) scanResult = result
      return result
    } catch (error) {
      if (sequence === scanSequence) scanError = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      if (sequence === scanSequence) scanning = false
    }
  }

  // --- Effects ---
  $effect(() => {
    $InlayGallerySubmenuIndex
    selection.clear()
    closeViewer()
  })

  $effect(() => {
    characterFilter
    const validChatIds = availableChats.map((chat) => chat.id)
    if (chatFilter && !validChatIds.includes(chatFilter)) chatFilter = ''
  })

  $effect(() => {
    $InlayGallerySubmenuIndex
    allItems.length
    sortKey
    characterFilter
    chatFilter
    specialFilter
    incrementalList.reset()
    galleryScrollContainer?.scrollTo({ top: 0 })
  })

  // Rescan on each entry. Do not treat missing/failed scan results as unused.
  $effect(() => {
    const filter = specialFilter
    allItems
    untrack(() => {
      selection.clear()
      if (filter === 'orphan-message') void refreshReferenceScan().catch(notifyError)
    })
  })

  onDestroy(() => {
    revokeViewerUrl()
  })

  const loadAssets = async () => {
    loading = true
    const [items, index] = await Promise.all([
      listInlayExplorerItems(),
      Promise.resolve(getCharacterChatIndex()),
    ])
    allItems = items
    characterIndex = index
    loading = false
  }
  loadAssets()
</script>

<div class="min-h-0 flex flex-col {$InlayGallerySubmenuIndex !== 2 ? 'h-full overflow-hidden' : ''}">
  <div class="shrink-0">
    <SettingPage title={language.inlayGallery.inlayImageGallery}>
      <SettingTabs tabs={[
        { label: language.inlayGallery.inlayImageList, value: 0 },
        { label: language.inlayGallery.inlayMediaList, value: 1 },
        { label: language.settings, value: 2 },
      ]} bind:selected={$InlayGallerySubmenuIndex} />
    </SettingPage>
  </div>

  {#if $InlayGallerySubmenuIndex === 2}
    <SettingRenderer items={inlayImageSettingsItems} layout="row" />
  {:else}
    <header class="shrink-0 flex flex-col gap-3 bg-lightbg pb-4">
      <div class="flex flex-wrap gap-3 items-center">
        <span class="text-subtext text-sm">
          {language.inlayGallery.inlayTotalAssets.replace('{count}', filteredItems.length.toString())}
        </span>
        <div class="flex gap-2 ml-auto">
          {#if hasSelection}
            <Button onclick={deleteSelected} variant="destructive" size="sm">{language.inlayGallery.inlayDeleteSelected}</Button>
            <Button onclick={deselectAll} variant="outline" size="sm">
              {language.inlayGallery.inlayDeselectAll} ({selection.size})
            </Button>
          {:else}
            <Button onclick={selectAll} variant="outline" size="sm" disabled={filteredItems.length === 0}>{language.inlayGallery.inlaySelectAll}</Button>
          {/if}
        </div>
      </div>

      {#if tabItems.length > 0}
        <SettingLayout variant="filter" title={language.systemLogsFilters} bind:open={filtersOpen} activeCount={activeFilterCount}>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-2 pt-2">
              <div class="flex flex-col gap-1 text-xs text-subtext">
                <span>{language.inlayGallery.inlaySort}</span>
                <Select bind:value={sortKey} size="sm">
                  <SelectOption value="updated-desc">{language.inlayGallery.inlaySortUpdatedDesc}</SelectOption>
                  <SelectOption value="updated-asc">{language.inlayGallery.inlaySortUpdatedAsc}</SelectOption>
                  <SelectOption value="created-desc">{language.inlayGallery.inlaySortCreatedDesc}</SelectOption>
                  <SelectOption value="created-asc">{language.inlayGallery.inlaySortCreatedAsc}</SelectOption>
                </Select>
              </div>
              <div class="flex flex-col gap-1 text-xs text-subtext">
                <span>{language.character}</span>
                <Select bind:value={characterFilter} size="sm">
                  <SelectOption value="">{language.none}</SelectOption>
                  {#each characterIndex as char (char.chaId)}
                    <SelectOption value={char.chaId}>{char.name}</SelectOption>
                  {/each}
                </Select>
              </div>
              <div class="flex flex-col gap-1 text-xs text-subtext">
                <span>{language.Chat}</span>
                <Select bind:value={chatFilter} size="sm">
                  <SelectOption value="">{language.none}</SelectOption>
                  {#each availableChats as chat (chat.id)}
                    <SelectOption value={chat.id}>{chat.name}</SelectOption>
                  {/each}
                </Select>
              </div>
              <div class="flex flex-col gap-1 text-xs text-subtext">
                <span>{language.inlayGallery.inlayFilter}</span>
                <Select bind:value={specialFilter} size="sm">
                  <SelectOption value="all">{language.inlayGallery.inlayFilterAll}</SelectOption>
                  <SelectOption value="meta-missing">{language.inlayGallery.inlayFilterMetaMissing}</SelectOption>
                  <SelectOption value="orphan-character">{language.inlayGallery.inlayFilterOrphanCharacter}</SelectOption>
                  <SelectOption value="orphan-chat">{language.inlayGallery.inlayFilterOrphanChat}</SelectOption>
                  <SelectOption value="orphan-message">{language.inlayGallery.inlayFilterOrphanMessage}</SelectOption>
                </Select>
              </div>
            </div>
        </SettingLayout>
      {/if}
    </header>

    <div bind:this={galleryScrollContainer} class="flex-1 min-h-0 overflow-y-auto pr-1 pb-4">
      {#if loading}
        <div class="min-h-full flex flex-col items-center justify-center gap-4">
          <LoaderCircleIcon class="size-12 animate-spin text-primary" />
          <p class="text-subtext text-sm">{language.inlayGallery.inlayLoadingMore}</p>
        </div>
      {:else if specialFilter === 'orphan-message' && scanning}
        <p class="text-subtext">{language.inlayGallery.inlayScanning}</p>
      {:else if specialFilter === 'orphan-message' && scanError}
        <p role="alert">{scanError}</p>
        <Button onclick={() => { void refreshReferenceScan().catch(notifyError) }} variant="outline" size="sm">{language.inlayGallery.inlayScanMessages}</Button>
      {:else if filteredItems.length === 0}
          <EmptyState
            title={activeFilterCount > 0 ? undefined : language.inlayGallery.inlayEmpty}
            description={activeFilterCount > 0 ? undefined : $InlayGallerySubmenuIndex === 0
              ? language.inlayGallery.inlayImageGalleryEmptyDesc
              : language.inlayGallery.inlayMediaGalleryEmptyDesc}
            layout="section" density="spacious" className="min-h-full"
          />
      {:else}
        <div class="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
          {#each displayedItems as item (item.id)}
            {@const statusLabel = getStatusLabel(item)}
            {@const characterName = getCharacterName(item)}
            <div
              class="relative group aspect-[2/3] rounded-lg overflow-hidden bg-darkbg border cursor-pointer select-none transition-colors
                {selection.has(item.id) ? 'border-lightborderc' : 'border-darkborderc hover:border-lightborderc/70'}"
              role="button"
              tabindex="0"
              onclick={(event) => handleCardClick(event, item.id)}
              onkeydown={(event) => handleCardKeydown(event, item.id)}
            >
              {#if item.type === 'image'}
                <img
                  alt={item.name}
                  class="w-full h-full object-cover"
                  src={getInlayThumbnailUrl(item.id)}
                  loading="lazy"
                  draggable={false}
                />
              {:else if item.type === 'video'}
                {#if failedVideoThumbnails.has(item.id)}
                  <div class="w-full h-full flex flex-col items-center justify-center gap-2 text-subtext/60">
                    <VideoIcon size={36} />
                    <span class="text-[10px]">{language.inlayGallery.inlayVideoAsset}</span>
                  </div>
                {:else}
                  <img
                    alt={item.name}
                    class="w-full h-full object-cover bg-darkbg"
                    src={getInlayVideoThumbnailUrl(item.id)}
                    loading="lazy"
                    draggable={false}
                    onerror={() => failedVideoThumbnails.add(item.id)}
                  />
                {/if}
              {:else}
                <div class="w-full h-full flex flex-col items-center justify-center gap-2 text-subtext/60">
                  <AudioLinesIcon size={36} />
                  <span class="text-[10px]">{language.inlayGallery.inlayAudioAsset}</span>
                </div>
              {/if}

              <div
                class="absolute top-1.5 left-1.5 z-10 size-5 transition-opacity
                  {selection.has(item.id) ? '' : 'opacity-0 group-hover:opacity-100'}"
                title={selection.has(item.id) ? language.inlayGallery.inlayDeselectAll : language.inlayGallery.inlaySelectAll}
              >
                <Checkbox
                  card
                  check={selection.has(item.id)}
                  hiddenName
                  margin={false}
                  className="size-5"
                  name={item.name}
                  onChange={() => toggleSelect(item.id)}
                />
              </div>

              {#if statusLabel}
                <div
                  class="absolute top-1.5 right-1.5 z-10 w-4 h-4 rounded-full bg-warning text-darkbg flex items-center justify-center"
                  title={statusLabel}
                >
                  <span class="text-[9px] font-bold leading-none">!</span>
                </div>
              {/if}

              <div
                class="absolute inset-x-0 bottom-0 pt-8 pb-2 px-2
                  bg-gradient-to-t from-themeblack from-[-25%] to-transparent
                  opacity-0 group-hover:opacity-100 transition-opacity duration-150 flex flex-col"
              >
                <p class="text-themewhite text-xs font-medium truncate leading-tight">{item.name}</p>
                {#if characterName}
                  <p class="text-themewhite/50 text-[10px] truncate leading-tight">{characterName}</p>
                {/if}
                <div class="flex justify-between items-end mt-1.5">
                  <button
                    class="w-6 h-6 rounded bg-selected/70 hover:bg-lightborderc flex items-center justify-center text-maintext transition-colors"
                    onclick={(e) => { e.stopPropagation(); copyInlayReference(item.id) }}
                    title={language.copy}
                  >
                    <CopyIcon size={11} />
                  </button>
                  <div class="flex gap-1.5 justify-end">
                    <button
                      class="w-6 h-6 rounded bg-selected/70 hover:bg-lightborderc flex items-center justify-center text-maintext transition-colors"
                      onclick={(e) => { e.stopPropagation(); downloadInlayAsset(item.id) }}
                      title={language.download}
                    >
                      <DownloadIcon size={12} />
                    </button>
                    <button
                      class="w-6 h-6 rounded bg-danger/30 hover:bg-danger/70 flex items-center justify-center text-themewhite transition-colors"
                      onclick={(e) => { e.stopPropagation(); deleteAsset(item.id, item.name) }}
                      title={language.inlayGallery.inlayDelete}
                    >
                      <Trash2Icon size={12} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          {/each}
        </div>

        {#if hasMore}
          <div use:observePagingSentinel={sortedItems.length} class="flex items-center justify-center py-10">
            <LoaderCircleIcon class="size-7 animate-spin text-primary" />
          </div>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<!-- Fullscreen viewer -->
<FullscreenImageViewer
  open={viewerOpen}
  src={viewerUrl}
  alt={currentViewerItem?.name ?? viewerId}
  title={currentViewerItem?.name ?? viewerId}
  subtitle={viewerId}
  position={viewerIndex}
  total={sortedItems.length}
  loading={viewerLoading}
  error={viewerError}
  loadingLabel={language.inlayGallery.inlayLoadingOriginal}
  {canGoPrev}
  {canGoNext}
  metadataLabel={language.inlayGallery.inlayInfo}
  closeLabel={language.goback}
  onClose={closeViewer}
  onPrev={() => goToNeighbor(-1)}
  onNext={() => goToNeighbor(1)}
  onDelete={() => {
    if (currentViewerItem) return deleteAsset(currentViewerItem.id, currentViewerItem.name)
  }}
  onDownload={() => {
    if (currentViewerItem) return downloadInlayAsset(currentViewerItem.id)
  }}
>
  {#snippet viewerContent()}
    {#if currentViewerItem?.type === 'video'}
      <!-- svelte-ignore a11y_media_has_caption: user-provided inlay media has no caption source -->
      <video
        src={viewerUrl}
        controls
        playsinline
        class="max-w-full max-h-full rounded shadow-2xl"
      ></video>
    {:else if currentViewerItem?.type === 'audio'}
      <div class="flex w-full max-w-xl flex-col items-center gap-6 rounded-lg border border-darkborderc bg-darkbg p-8">
        <AudioLinesIcon size={64} class="text-subtext" />
        <audio src={viewerUrl} controls class="w-full"></audio>
      </div>
    {:else}
      <img
        src={viewerUrl}
        alt={currentViewerItem?.name ?? viewerId}
        class="max-w-full max-h-full object-contain rounded shadow-2xl"
      />
    {/if}
  {/snippet}

  {#snippet actions()}
    {#if currentViewerItem}
      <AssetViewerActions
        onCopy={() => copyInlayReference(currentViewerItem.id)}
        onDownload={() => downloadInlayAsset(currentViewerItem.id)}
        onDelete={() => deleteAsset(currentViewerItem.id, currentViewerItem.name)}
      />
    {/if}
  {/snippet}

  {#snippet metadataOverlay()}
    {#if currentViewerItem}
      <InlayViewerMetadata
        item={currentViewerItem}
        characterName={getCharacterName(currentViewerItem)}
        chatName={getChatName(currentViewerItem)}
        characterStatus={isOrphanCharacter(currentViewerItem) ? language.inlayGallery.inlayFilterOrphanCharacter : null}
        chatStatus={isOrphanChat(currentViewerItem) ? language.inlayGallery.inlayFilterOrphanChat : null}
      />
    {/if}
  {/snippet}
</FullscreenImageViewer>
