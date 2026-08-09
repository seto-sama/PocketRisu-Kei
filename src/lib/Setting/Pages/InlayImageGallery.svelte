<script lang="ts">
  import { onDestroy } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import { AudioLines, Copy, Download, Trash2, Video } from '@lucide/svelte'
  import OptionInput from "../../UI/GUI/OptionInput.svelte";
  import CheckInput from '../../UI/GUI/CheckInput.svelte'
  import ShButton from '../../UI/GUI/ShButton.svelte'
  import ShSelect from '../../UI/GUI/ShSelect.svelte'

  import { language } from 'src/lang'
  import { SizeStore } from 'src/ts/stores.svelte'
  import { alertConfirm, notifySuccess, notifyError } from 'src/ts/alert'
  import { downloadFile } from 'src/ts/globalApi.svelte'
  import {
    getCharacterChatIndex,
    getInlayAssetBlob,
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

  let submenu = $state(0)

  const PAGE_SIZE = 40

  type SortKey = 'created-desc' | 'created-asc' | 'updated-desc' | 'updated-asc'
  type SpecialFilter = 'all' | 'meta-missing' | 'orphan-character' | 'orphan-chat' | 'orphan-message'

  // Data state
  let allItems = $state<InlayExplorerItem[]>([])
  let characterIndex = $state<CharacterChatIndexItem[]>([])
  let displayCount = $state(PAGE_SIZE)
  let loading = $state(true)
  let paging = $state(false)
  let galleryScrollContainer: HTMLDivElement | null = $state(null)
  let loadMoreSentinel: HTMLDivElement | null = $state(null)
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
  // Mobile defaults to preview-only — a narrow info panel would dominate the viewport.
  let infoPanelOpen = $state($SizeStore.w >= 768)

  // --- Derived ---
  const activeFilterCount = $derived(
    (characterFilter !== '' ? 1 : 0) +
    (chatFilter !== '' ? 1 : 0) +
    (specialFilter !== 'all' ? 1 : 0)
  )
  const characterMap = $derived(new Map(characterIndex.map((char) => [char.chaId, char])))
  const allChatIds = $derived(new Set(characterIndex.flatMap((char) => char.chats.map((chat) => chat.id))))
  const availableChats = $derived(characterFilter ? (characterMap.get(characterFilter)?.chats ?? []) : [])
  const tabItems = $derived(allItems.filter((item) => submenu === 0
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

  const displayedItems = $derived(sortedItems.slice(0, displayCount))
  const hasMore = $derived(displayCount < sortedItems.length)
  const hasSelection = $derived(selection.size > 0)
  const currentViewerItem = $derived(sortedItems.find((item) => item.id === viewerId) ?? null)
  const viewerIndex = $derived(sortedItems.findIndex((item) => item.id === viewerId))
  const canGoPrev = $derived(viewerIndex > 0)
  const canGoNext = $derived(viewerIndex >= 0 && viewerIndex < sortedItems.length - 1)

  // --- Helpers ---
  function getSortTimestamp(item: InlayExplorerItem, key: SortKey): number {
    if (key.startsWith('created')) return item.meta?.createdAt ?? 0
    return item.meta?.updatedAt ?? 0
  }

  function getCharacterName(item: InlayExplorerItem | null): string | null {
    const charId = item?.meta?.charId
    if (!charId) return null
    return characterMap.get(charId)?.name ?? charId
  }

  function getChatName(item: InlayExplorerItem | null): string | null {
    const charId = item?.meta?.charId
    const chatId = item?.meta?.chatId
    if (!chatId) return null
    if (charId) {
      const chat = characterMap.get(charId)?.chats.find((entry) => entry.id === chatId)
      return chat?.name ?? chatId
    }
    for (const char of characterIndex) {
      const chat = char.chats.find((entry) => entry.id === chatId)
      if (chat) return chat.name
    }
    return chatId
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
    if (!item.hasMeta) return language.playground.inlayFilterMetaMissing
    if (isOrphanCharacter(item)) return language.playground.inlayFilterOrphanCharacter
    if (isOrphanChat(item)) return language.playground.inlayFilterOrphanChat
    return null
  }

  function formatTimestamp(value?: number): string | null {
    if (!value || value <= 0) return null
    return new Date(value).toLocaleString()
  }

  function sanitizeFileName(name: string): string {
    const trimmed = name.trim()
    const fallback = trimmed.length > 0 ? trimmed : 'inlay-asset.bin'
    return fallback.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
  }

  function buildInlayReference(id: string): string {
    return `{{inlayed::${id}}}`
  }

  async function copyInlayReference(id: string) {
    try {
      await navigator.clipboard.writeText(buildInlayReference(id))
      notifySuccess(language.copied)
    } catch (error) {
      notifyError(`${error}`)
    }
  }

  function withExtension(name: string, ext: string): string {
    const safeExt = (ext ?? '').trim() || 'bin'
    const lowerName = name.toLowerCase()
    if (lowerName.endsWith(`.${safeExt.toLowerCase()}`)) return name
    const lastDot = name.lastIndexOf('.')
    const base = lastDot > 0 ? name.slice(0, lastDot) : name
    return `${base}.${safeExt}`
  }

  function revokeViewerUrl() {
    viewerUrl = ''
  }

  function getAssetUrl(id: string): string {
    return `/api/asset/${Buffer.from('inlay/' + id, 'utf-8').toString('hex')}`
  }

  function getVideoThumbnailUrl(id: string): string {
    return `/api/asset/${Buffer.from('inlay_video_thumb/' + id, 'utf-8').toString('hex')}`
  }

  function loadViewerAsset(id: string) {
    revokeViewerUrl()
    viewerLoading = false
    viewerError = ''
    // Use direct /api/asset/ URL — browser handles caching via HTTP headers
    viewerUrl = getAssetUrl(id)
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
    if (viewerIndex < 0) return
    const nextItem = sortedItems[viewerIndex + offset]
    if (!nextItem) return
    openViewer(nextItem.id)
  }

  async function downloadCurrent(item: InlayExplorerItem) {
    try {
      const asset = await getInlayAssetBlob(item.id)
      if (!asset) {
        notifyError('Failed to load image for download.')
        return
      }
      const buffer = new Uint8Array(await asset.data.arrayBuffer())
      await downloadFile(sanitizeFileName(withExtension(asset.name, asset.ext)), buffer)
      notifySuccess(language.successExport)
    } catch (error) {
      notifyError(`${error}`)
    }
  }

  const toggleSelect = (id: string) => {
    if (selection.has(id)) selection.delete(id)
    else selection.add(id)
  }

  const selectAll = () => displayedItems.forEach((item) => selection.add(item.id))
  const deselectAll = () => selection.clear()

  const deleteAsset = async (id: string, name: string) => {
    if (!(await alertConfirm(language.playground.inlayDeleteConfirm.replace('{name}', name)))) return
    await removeInlayAsset(id)
    selection.delete(id)
    allItems = allItems.filter((item) => item.id !== id)
    if (viewerId === id) {
      const currentIndex = sortedItems.findIndex((item) => item.id === id)
      const nextItem = sortedItems[currentIndex + 1] ?? sortedItems[currentIndex - 1] ?? null
      if (nextItem) openViewer(nextItem.id)
      else closeViewer()
    }
  }

  const deleteSelected = async () => {
    if (selection.size === 0) return
    if (!(await alertConfirm(language.playground.inlayDeleteMultipleConfirm.replace('{count}', selection.size.toString())))) return
    const ids = allItems.filter((item) => selection.has(item.id)).map((item) => item.id)
    await removeInlayAssets(ids)
    allItems = allItems.filter((item) => !selection.has(item.id))
    if (viewerId && selection.has(viewerId)) closeViewer()
    selection.clear()
  }

  // --- Effects ---
  $effect(() => {
    submenu
    selection.clear()
    closeViewer()
  })

  $effect(() => {
    characterFilter
    const validChatIds = availableChats.map((chat) => chat.id)
    if (chatFilter && !validChatIds.includes(chatFilter)) chatFilter = ''
  })

  $effect(() => {
    submenu
    allItems.length
    sortKey
    characterFilter
    chatFilter
    specialFilter
    displayCount = PAGE_SIZE
    galleryScrollContainer?.scrollTo({ top: 0 })
  })

  // Auto-scan when orphan-message filter is selected
  $effect(() => {
    if (specialFilter === 'orphan-message' && !scanResult) {
      scanResult = scanInlayReferences()
    }
  })

  // Infinite scroll.
  // The component's own `flex-1 overflow-y-auto` container never actually
  // scrolls because the Settings layout doesn't propagate a height to it —
  // real scrolling happens on an ancestor (rs-setting-cont-4). So we resolve
  // the closest scrollable ancestor at runtime and use it as the observer root.
  let observer: IntersectionObserver | null = null
  $effect(() => {
    if (!galleryScrollContainer || !loadMoreSentinel || !hasMore) {
      observer?.disconnect()
      return
    }
    let rootEl: HTMLElement | null = null
    let p: HTMLElement | null = galleryScrollContainer.parentElement
    while (p) {
      const oy = getComputedStyle(p).overflowY
      if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) {
        rootEl = p
        break
      }
      p = p.parentElement
    }
    const loadMore = () => {
      if (!hasMore || loading || paging) return
      paging = true
      displayCount += PAGE_SIZE
      queueMicrotask(() => { paging = false })
    }
    observer?.disconnect()
    observer = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) loadMore() },
      { root: rootEl, rootMargin: '200px 0px', threshold: 0 }
    )
    observer.observe(loadMoreSentinel)
    return () => {
      observer?.disconnect()
      observer = null
    }
  })

  onDestroy(() => {
    observer?.disconnect()
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

<div class="min-h-0 flex flex-col {submenu !== 2 ? 'h-full overflow-hidden' : ''}">
  <div class="shrink-0">
    <SettingPage title={language.playground.inlayImageGallery}>
      <SettingTabs tabs={[
        { label: language.playground.inlayImageList, value: 0 },
        { label: language.playground.inlayMediaList, value: 1 },
        { label: language.settings, value: 2 },
      ]} bind:selected={submenu} />
    </SettingPage>
  </div>

  {#if submenu === 2}
    <SettingRenderer items={inlayImageSettingsItems} layout="row" />
  {:else}
    <header class="shrink-0 flex flex-col gap-3 bg-bgcolor pb-4">
      <div class="flex flex-wrap gap-3 items-center">
        <span class="text-textcolor2 text-sm">
          {language.playground.inlayTotalAssets.replace('{count}', filteredItems.length.toString())}
        </span>
        <div class="flex gap-2 ml-auto">
          {#if hasSelection}
            <ShButton onclick={deleteSelected} variant="destructive" size="sm">{language.playground.inlayDeleteSelected}</ShButton>
            <ShButton onclick={deselectAll} variant="outline" size="sm">
              {language.playground.inlayDeselectAll} ({selection.size})
            </ShButton>
          {:else if filteredItems.length > 0}
            <ShButton onclick={selectAll} variant="outline" size="sm">{language.playground.inlaySelectAll}</ShButton>
          {/if}
        </div>
      </div>

      {#if tabItems.length > 0}
        <SettingLayout variant="filter" title={language.systemLogsFilters} bind:open={filtersOpen} activeCount={activeFilterCount}>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-2 pt-2">
              <div class="flex flex-col gap-1 text-xs text-textcolor2">
                <span>{language.playground.inlaySort}</span>
                <ShSelect bind:value={sortKey} size="sm">
                  <OptionInput value="updated-desc">{language.playground.inlaySortUpdatedDesc}</OptionInput>
                  <OptionInput value="updated-asc">{language.playground.inlaySortUpdatedAsc}</OptionInput>
                  <OptionInput value="created-desc">{language.playground.inlaySortCreatedDesc}</OptionInput>
                  <OptionInput value="created-asc">{language.playground.inlaySortCreatedAsc}</OptionInput>
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
                <span>{language.playground.inlayFilter}</span>
                <ShSelect bind:value={specialFilter} size="sm">
                  <OptionInput value="all">{language.playground.inlayFilterAll}</OptionInput>
                  <OptionInput value="meta-missing">{language.playground.inlayFilterMetaMissing}</OptionInput>
                  <OptionInput value="orphan-character">{language.playground.inlayFilterOrphanCharacter}</OptionInput>
                  <OptionInput value="orphan-chat">{language.playground.inlayFilterOrphanChat}</OptionInput>
                  <OptionInput value="orphan-message">{language.playground.inlayFilterOrphanMessage}</OptionInput>
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
          <p class="text-textcolor2 text-sm">{language.playground.inlayLoadingMore}</p>
        </div>
      {:else if filteredItems.length === 0}
        <div class="min-h-full flex flex-col items-center justify-center text-center text-textcolor2">
          <p class="text-lg">{language.playground.inlayEmpty}</p>
          <p class="text-sm mt-2">
            {submenu === 0
              ? language.playground.inlayImageGalleryEmptyDesc
              : language.playground.inlayMediaGalleryEmptyDesc}
          </p>
        </div>
      {:else}
        <div class="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
          {#each displayedItems as item (item.id)}
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
                  src={`/api/asset/${Buffer.from('inlay_thumb/' + item.id, 'utf-8').toString('hex')}`}
                  loading="lazy"
                  draggable={false}
                />
              {:else if item.type === 'video'}
                {#if failedVideoThumbnails.has(item.id)}
                  <div class="w-full h-full flex flex-col items-center justify-center gap-2 text-textcolor2/60">
                    <Video size={36} />
                    <span class="text-[10px]">{language.playground.inlayVideoAsset}</span>
                  </div>
                {:else}
                  <img
                    alt={item.name}
                    class="w-full h-full object-cover bg-darkbg"
                    src={getVideoThumbnailUrl(item.id)}
                    loading="lazy"
                    draggable={false}
                    onerror={() => failedVideoThumbnails.add(item.id)}
                  />
                {/if}
              {:else}
                <div class="w-full h-full flex flex-col items-center justify-center gap-2 text-textcolor2/60">
                  <AudioLines size={36} />
                  <span class="text-[10px]">{language.playground.inlayAudioAsset}</span>
                </div>
              {/if}

              <div
                class="absolute top-1.5 left-1.5 z-10 transition-opacity
                  {selection.has(item.id) ? '' : 'opacity-0 group-hover:opacity-100'}"
                title={selection.has(item.id) ? language.playground.inlayDeselectAll : language.playground.inlaySelectAll}
              >
                <CheckInput
                  card
                  check={selection.has(item.id)}
                  hiddenName
                  margin={false}
                  name={item.name}
                  onChange={() => toggleSelect(item.id)}
                />
              </div>

              {#if getStatusLabel(item)}
                <div
                  class="absolute top-1.5 right-1.5 z-10 w-4 h-4 rounded-full bg-warning text-darkbg flex items-center justify-center"
                  title={getStatusLabel(item) ?? ''}
                >
                  <span class="text-[9px] font-bold leading-none">!</span>
                </div>
              {/if}

              <div
                class="absolute inset-x-0 bottom-0 pt-8 pb-2 px-2
                  bg-gradient-to-t from-black/80 via-black/40 to-transparent
                  opacity-0 group-hover:opacity-100 transition-opacity duration-150 flex flex-col"
              >
                <p class="text-white text-xs font-medium truncate leading-tight">{item.name}</p>
                {#if getCharacterName(item)}
                  <p class="text-white/60 text-[10px] truncate leading-tight">{getCharacterName(item)}</p>
                {/if}
                <div class="flex justify-between items-end mt-1.5">
                  <button
                    class="w-6 h-6 rounded bg-selected/70 hover:bg-borderc flex items-center justify-center text-textcolor transition-colors"
                    onclick={(e) => { e.stopPropagation(); copyInlayReference(item.id) }}
                    title={language.copy}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="11"
                      height="11"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      class="lucide-icon lucide lucide-copy"
                    >
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                    </svg>
                  </button>
                  <div class="flex gap-1.5 justify-end">
                    <button
                      class="w-6 h-6 rounded bg-selected/70 hover:bg-borderc flex items-center justify-center text-textcolor transition-colors"
                      onclick={(e) => { e.stopPropagation(); downloadCurrent(item) }}
                      title={language.download}
                    >
                      <Download size={12} />
                    </button>
                    <button
                      class="w-6 h-6 rounded bg-draculared/30 hover:bg-draculared/70 flex items-center justify-center text-white transition-colors"
                      onclick={(e) => { e.stopPropagation(); deleteAsset(item.id, item.name) }}
                      title={language.playground.inlayDelete}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          {/each}
        </div>

        {#if hasMore}
          <div bind:this={loadMoreSentinel} class="flex items-center justify-center py-10">
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
  position={viewerIndex}
  total={sortedItems.length}
  loading={viewerLoading}
  error={viewerError}
  loadingLabel={language.playground.inlayLoadingOriginal}
  {canGoPrev}
  {canGoNext}
  bind:infoOpen={infoPanelOpen}
  infoLabel={language.playground.inlayInfo}
  downloadLabel={language.download}
  closeLabel={language.goback}
  onClose={closeViewer}
  onPrev={() => goToNeighbor(-1)}
  onNext={() => goToNeighbor(1)}
  onDownload={() => currentViewerItem && downloadCurrent(currentViewerItem)}
>
  {#snippet viewerContent()}
    {#if currentViewerItem?.type === 'video'}
      <!-- svelte-ignore a11y_media_has_caption: user-provided inlay media has no caption source -->
      <video
        src={viewerUrl}
        controls
        playsinline
        class="max-w-full max-h-full rounded shadow-2xl"
        style="max-height: calc(100vh - 112px);"
      ></video>
    {:else if currentViewerItem?.type === 'audio'}
      <div class="flex w-full max-w-xl flex-col items-center gap-6 rounded-lg border border-darkborderc bg-darkbg p-8">
        <AudioLines size={64} class="text-textcolor2" />
        <audio src={viewerUrl} controls class="w-full"></audio>
      </div>
    {:else}
      <img
        src={viewerUrl}
        alt={currentViewerItem?.name ?? viewerId}
        class="max-w-full max-h-full object-contain rounded shadow-2xl"
        style="max-height: calc(100vh - 112px);"
      />
    {/if}
  {/snippet}

  {#snippet statusOverlay()}
    {#if getStatusLabel(currentViewerItem)}
      <div class="risu-status-warning absolute bottom-4 left-1/2 -translate-x-1/2 z-10 px-3 py-1 rounded-full text-xs font-medium">
        {getStatusLabel(currentViewerItem)}
      </div>
    {/if}
  {/snippet}

  {#snippet info()}
    <div class="px-4 py-3 space-y-1.5">
      <p class="text-textcolor text-sm font-medium break-all leading-snug" title={currentViewerItem?.name}>
        {currentViewerItem?.name ?? viewerId}
      </p>
      <p class="text-textcolor2/60 text-xs font-mono break-all leading-snug">{viewerId}</p>
      {#if currentViewerItem?.ext}
        <p class="text-textcolor2 text-xs uppercase font-mono">{currentViewerItem.ext}</p>
      {/if}
      {#if currentViewerItem?.width && currentViewerItem?.height}
        <p class="text-textcolor2 text-xs">{currentViewerItem.width} × {currentViewerItem.height} px</p>
      {/if}
      {#if getCharacterName(currentViewerItem)}
        <p class="text-textcolor2 text-xs">{language.character}: {getCharacterName(currentViewerItem)}</p>
      {/if}
      {#if getChatName(currentViewerItem)}
        <p class="text-textcolor2 text-xs">{language.Chat}: {getChatName(currentViewerItem)}</p>
      {/if}
      {#if formatTimestamp(currentViewerItem?.meta?.createdAt)}
        <p class="text-textcolor2/70 text-xs">{language.playground.inlayCreatedAt} {formatTimestamp(currentViewerItem?.meta?.createdAt)}</p>
      {/if}
    </div>

    <div class="px-4 py-4 space-y-2">
      <h3 class="text-textcolor2 text-[11px] font-semibold uppercase tracking-wider">
        {language.playground.inlayActions}
      </h3>
      <button
        type="button"
        onclick={() => currentViewerItem && copyInlayReference(currentViewerItem.id)}
        class="w-full flex items-center gap-2 px-3 py-2 rounded border border-darkborderc risu-interactive-surface-strong text-textcolor2 risu-interactive-foreground text-sm transition-colors"
      >
        <Copy size={14} />
        {language.copy}
      </button>
      <button
        type="button"
        onclick={() => currentViewerItem && downloadCurrent(currentViewerItem)}
        class="w-full flex items-center gap-2 px-3 py-2 rounded border border-darkborderc risu-interactive-surface-strong text-textcolor2 risu-interactive-foreground text-sm transition-colors"
      >
        <Download size={12} />
        {language.download}
      </button>
      <button
        type="button"
        onclick={() => currentViewerItem && deleteAsset(currentViewerItem.id, currentViewerItem.name)}
        class="w-full flex items-center gap-2 px-3 py-2 rounded border border-draculared/40 hover:bg-draculared/15 text-draculared text-sm transition-colors"
      >
        <Trash2 size={12} />
        {language.playground.inlayDelete}
      </button>
    </div>
  {/snippet}
</FullscreenImageViewer>
