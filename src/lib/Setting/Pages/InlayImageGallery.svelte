<script lang="ts">
  import { onDestroy } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import { AudioLinesIcon, CopyIcon, DownloadIcon, Trash2Icon, VideoIcon } from '@lucide/svelte'
  import OptionInput from "../../UI/GUI/OptionInput.svelte";
  import CheckInput from '../../UI/GUI/CheckInput.svelte'
  import ShButton from '../../UI/GUI/ShButton.svelte'
  import ShSelect from '../../UI/GUI/ShSelect.svelte'

  import { language } from 'src/lang'
  import { InlayGallerySubmenuIndex } from 'src/ts/stores.svelte'
  import { alertConfirm } from 'src/ts/alert'
  import {
    getCharacterChatIndex,
    getInlayAssetUrl,
    getInlayThumbnailUrl,
    getInlayVideoThumbnailUrl,
    listInlayExplorerItems,
    removeInlayAsset,
    removeInlayAssets,
    scanInlayReferences,
    type CharacterChatIndexItem,
    type InlayExplorerItem,
    type InlayScanResult,
  } from 'src/ts/process/files/inlays'
  import SettingPage from '../../UI/GUI/SettingPage.svelte'
  import SettingLayout from '../Wrappers/SettingLayout.svelte'
  import SettingTabs from '../../UI/GUI/SettingTabs.svelte'
  import SettingRenderer from '../SettingRenderer.svelte'
  import { inlayImageSettingsItems } from 'src/ts/setting/inlayImageSettingsData'
  import FullscreenImageViewer from '../../UI/GUI/FullscreenImageViewer.svelte'
  import IconButton from '../../UI/GUI/IconButton.svelte'
  import AssetViewerActions from '../../UI/GUI/AssetViewerActions.svelte'
  import InlayViewerMetadata from '../../UI/GUI/InlayViewerMetadata.svelte'
  import { createIncrementalList } from '../../UI/incrementalList.svelte'
  import { copyInlayReference, downloadInlayAsset } from '../../UI/inlayViewerActions'

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

  // Viewer state
  let viewerOpen = $state(false)
  let viewerId = $state('')
  let viewerUrl = $state('')
  let viewerLoading = $state(false)
  let viewerError = $state('')
  let deletingAsset = false
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
        if (specialFilter === 'orphan-message' && (scanResult?.refCounts[item.id] ?? 0) > 0) return false
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
    if (event.target instanceof Element && event.target.closest('label')) return
    openViewer(id)
  }

  function handleCardKeydown(event: KeyboardEvent, id: string) {
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

  const selectAll = () => displayedItems.forEach((item) => selection.add(item.id))
  const deselectAll = () => selection.clear()

  const deleteAsset = async (id: string, name: string) => {
    if (deletingAsset) return
    deletingAsset = true
    try {
      if (!(await alertConfirm(language.inlayGallery.inlayDeleteConfirm.replace('{name}', name)))) return
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
    } finally {
      deletingAsset = false
    }
  }

  const deleteSelected = async () => {
    if (selection.size === 0) return
    if (!(await alertConfirm(language.inlayGallery.inlayDeleteMultipleConfirm.replace('{count}', selection.size.toString())))) return
    const ids = allItems.filter((item) => selection.has(item.id)).map((item) => item.id)
    await removeInlayAssets(ids)
    allItems = allItems.filter((item) => !selection.has(item.id))
    if (viewerId && selection.has(viewerId)) closeViewer()
    selection.clear()
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

  // Auto-scan when orphan-message filter is selected
  $effect(() => {
    if (specialFilter === 'orphan-message' && !scanResult) {
      scanResult = scanInlayReferences()
    }
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
    <header class="shrink-0 flex flex-col gap-3 bg-bgcolor pb-4">
      <div class="flex flex-wrap gap-3 items-center">
        <span class="text-textcolor2 text-sm">
          {language.inlayGallery.inlayTotalAssets.replace('{count}', filteredItems.length.toString())}
        </span>
        <div class="flex gap-2 ml-auto">
          {#if hasSelection}
            <ShButton onclick={deleteSelected} variant="destructive" size="sm">{language.inlayGallery.inlayDeleteSelected}</ShButton>
            <ShButton onclick={deselectAll} variant="outline" size="sm">
              {language.inlayGallery.inlayDeselectAll} ({selection.size})
            </ShButton>
          {:else if filteredItems.length > 0}
            <ShButton onclick={selectAll} variant="outline" size="sm">{language.inlayGallery.inlaySelectAll}</ShButton>
          {/if}
        </div>
      </div>

      {#if tabItems.length > 0}
        <SettingLayout variant="filter" title={language.systemLogsFilters} bind:open={filtersOpen} activeCount={activeFilterCount}>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-2 pt-2">
              <div class="flex flex-col gap-1 text-xs text-textcolor2">
                <span>{language.inlayGallery.inlaySort}</span>
                <ShSelect bind:value={sortKey} size="sm">
                  <OptionInput value="updated-desc">{language.inlayGallery.inlaySortUpdatedDesc}</OptionInput>
                  <OptionInput value="updated-asc">{language.inlayGallery.inlaySortUpdatedAsc}</OptionInput>
                  <OptionInput value="created-desc">{language.inlayGallery.inlaySortCreatedDesc}</OptionInput>
                  <OptionInput value="created-asc">{language.inlayGallery.inlaySortCreatedAsc}</OptionInput>
                </ShSelect>
              </div>
              <div class="flex flex-col gap-1 text-xs text-textcolor2">
                <span>{language.character}</span>
                <ShSelect bind:value={characterFilter} size="sm">
                  <OptionInput value="">{language.none}</OptionInput>
                  {#each characterIndex as char (char.chaId)}
                    <OptionInput value={char.chaId}>{char.name}</OptionInput>
                  {/each}
                </ShSelect>
              </div>
              <div class="flex flex-col gap-1 text-xs text-textcolor2">
                <span>{language.Chat}</span>
                <ShSelect bind:value={chatFilter} size="sm">
                  <OptionInput value="">{language.none}</OptionInput>
                  {#each availableChats as chat (chat.id)}
                    <OptionInput value={chat.id}>{chat.name}</OptionInput>
                  {/each}
                </ShSelect>
              </div>
              <div class="flex flex-col gap-1 text-xs text-textcolor2">
                <span>{language.inlayGallery.inlayFilter}</span>
                <ShSelect bind:value={specialFilter} size="sm">
                  <OptionInput value="all">{language.inlayGallery.inlayFilterAll}</OptionInput>
                  <OptionInput value="meta-missing">{language.inlayGallery.inlayFilterMetaMissing}</OptionInput>
                  <OptionInput value="orphan-character">{language.inlayGallery.inlayFilterOrphanCharacter}</OptionInput>
                  <OptionInput value="orphan-chat">{language.inlayGallery.inlayFilterOrphanChat}</OptionInput>
                  <OptionInput value="orphan-message">{language.inlayGallery.inlayFilterOrphanMessage}</OptionInput>
                </ShSelect>
              </div>
            </div>
        </SettingLayout>
      {/if}
    </header>

    <div bind:this={galleryScrollContainer} class="flex-1 min-h-0 overflow-y-auto pr-1 pb-4">
      {#if loading}
        <div class="min-h-full flex flex-col items-center justify-center gap-4">
          <div class="w-12 h-12 border-4 border-darkborderc border-t-borderc rounded-full animate-spin"></div>
          <p class="text-textcolor2 text-sm">{language.inlayGallery.inlayLoadingMore}</p>
        </div>
      {:else if filteredItems.length === 0}
        <div class="min-h-full flex flex-col items-center justify-center text-center text-textcolor2">
          <p class="text-lg">{language.inlayGallery.inlayEmpty}</p>
          <p class="text-sm mt-2">
            {$InlayGallerySubmenuIndex === 0
              ? language.inlayGallery.inlayImageGalleryEmptyDesc
              : language.inlayGallery.inlayMediaGalleryEmptyDesc}
          </p>
        </div>
      {:else}
        <div class="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
          {#each displayedItems as item (item.id)}
            {@const statusLabel = getStatusLabel(item)}
            {@const characterName = getCharacterName(item)}
            <div
              class="relative group aspect-[2/3] rounded-lg overflow-hidden bg-darkbg border cursor-pointer select-none transition-colors
                {selection.has(item.id) ? 'border-borderc' : 'border-darkborderc risu-interactive-border/70'}"
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
                  <div class="w-full h-full flex flex-col items-center justify-center gap-2 text-textcolor2/60">
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
                <div class="w-full h-full flex flex-col items-center justify-center gap-2 text-textcolor2/60">
                  <AudioLinesIcon size={36} />
                  <span class="text-[10px]">{language.inlayGallery.inlayAudioAsset}</span>
                </div>
              {/if}

              {#if !selection.has(item.id)}
                <span
                  class="pointer-events-none absolute top-1.5 left-1.5 z-10 size-5 rounded bg-darkbg/50
                    opacity-0 mix-blend-multiply transition-opacity group-hover:opacity-100"
                  aria-hidden="true"
                ></span>
              {/if}

              <div
                class="absolute top-1.5 left-1.5 z-10 transition-opacity
                  {selection.has(item.id) ? '' : 'opacity-0 group-hover:opacity-100'}"
                title={selection.has(item.id) ? language.inlayGallery.inlayDeselectAll : language.inlayGallery.inlaySelectAll}
              >
                <CheckInput
                  card
                  cardUncheckedFill={false}
                  check={selection.has(item.id)}
                  hiddenName
                  margin={false}
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
                  bg-gradient-to-t from-black from-[-25%] to-transparent
                  opacity-0 group-hover:opacity-100 transition-opacity duration-150 flex flex-col"
              >
                <p class="text-white text-xs font-medium truncate leading-tight">{item.name}</p>
                {#if characterName}
                  <p class="text-white/60 text-[10px] truncate leading-tight">{characterName}</p>
                {/if}
                <div class="flex justify-between items-end mt-1.5">
                  <button
                    class="w-6 h-6 rounded bg-selected/70 hover:bg-borderc flex items-center justify-center text-textcolor transition-colors"
                    onclick={(e) => { e.stopPropagation(); copyInlayReference(item.id) }}
                    title={language.copy}
                  >
                    <CopyIcon size={11} />
                  </button>
                  <div class="flex gap-1.5 justify-end">
                    <button
                      class="w-6 h-6 rounded bg-selected/70 hover:bg-borderc flex items-center justify-center text-textcolor transition-colors"
                      onclick={(e) => { e.stopPropagation(); downloadInlayAsset(item.id) }}
                      title={language.download}
                    >
                      <DownloadIcon size={12} />
                    </button>
                    <button
                      class="w-6 h-6 rounded bg-draculared/30 hover:bg-draculared/70 flex items-center justify-center text-white transition-colors"
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
            <div class="w-7 h-7 border-4 border-darkborderc border-t-borderc rounded-full animate-spin"></div>
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
        <AudioLinesIcon size={64} class="text-textcolor2" />
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
