<script lang="ts">
  import FolderAvatar from './FolderAvatar.svelte';
  import type { folder as CharacterFolder } from 'src/ts/storage/database.svelte';

    import EmptyState from "src/lib/UI/components/EmptyState.svelte";
    import { onDestroy } from "svelte";
    import {
    CharEmotion,
    DynamicGUI,
    botMakerMode,
    selectedCharID,
    settingsOpen,
    sideBarClosing,
    sideBarStore,
    sidebarDevTool,
    OpenRealmStore,

    QuickSettings,

    additionalHamburgerMenu,
    bookmarkListOpen,

    leftBarCollapsed


  } from "../../ts/stores.svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import BarIcon from "./BarIcon.svelte";
    import {
    SettingsIcon,
    ListIcon,
    LayoutGridIcon,
    HomeIcon,
    MessageSquareIcon,
    PlusIcon,
    User2Icon,
    ChevronsLeftIcon,
    ArrowRightIcon,
    SearchIcon,
    BookmarkCheckIcon,
  } from "@lucide/svelte";
    import {
  addCharacter,
    changeChar,
    getCharImage,
  } from "../../ts/characters";
    import CharConfig from "./CharConfig.svelte";
    import { language } from "../../lang";
    import isEqual from "lodash/isEqual";
    import SidebarAvatar from "./SidebarAvatar.svelte";
    import Switch from "../UI/components/Switch.svelte";
    import Button from "../UI/components/Button.svelte";
    import SortableList from "../UI/components/SortableList.svelte";
    import type { SortableEvent } from "sortablejs";
    import { getCharacterIndexObject, makeAgoText } from "src/ts/util";
    import { v4 } from "uuid";
    import { checkCharOrder } from "src/ts/globalApi.svelte";
    import SideChatList from "./SideChatList.svelte";
    import { openSidebarFolderMenu } from "./sidebarFolderMenu";
    import {
      applySidebarDrop,
      createSidebarDragController,
      readSidebarOrderFromDom,
      SIDEBAR_DEFAULT_FOLDER_NAME,
      SIDEBAR_FOLDER_ITEM_SIZE,
      SIDEBAR_ROOT_ITEM_SIZE,
      SIDEBAR_SORTABLE_GROUP,
      type SidebarDropTarget,
    } from "./sidebarDrag";

  import { sideBarSize } from "src/ts/gui/guisize";
  import DevTool from "./DevTool.svelte";
  import CharConfigHeader from "./CharConfigHeader.svelte";
    import QuickSettingsGui from "../Others/QuickSettingsGUI.svelte";
    import PluginDefinedIcon from "../Others/PluginDefinedIcon.svelte";
    import IconButtonGroup from "../UI/components/IconButtonGroup.svelte";
    import IconButton from "../UI/components/IconButton.svelte";
    import Input from "../UI/components/Input.svelte";
    import CharacterMasonryIcon from "../UI/CharacterMasonryIcon.svelte";
    import HorizontalMasonry from "../UI/HorizontalMasonry.svelte";
    import { createIncrementalList } from "../UI/incrementalList.svelte";
    import {
      DEFAULT_SIDEBAR_MENU_ORDER,
      SIDEBAR_MENU_BOOKMARKS,
      SIDEBAR_MENU_CHARACTERS,
      SIDEBAR_MENU_HOME,
      SIDEBAR_MENU_SETTINGS,
      appendNewPluginMenuItems,
      dividerSidebarMenuKey,
      getSidebarMenuDisplayOrder,
      getVisibleSidebarMenuOrder,
      isSidebarMenuDivider,
      mergeVisibleSidebarMenuOrder,
      pluginSidebarMenuKey,
    } from "src/ts/sidebarMenuOrder";
  const isTouchDevice = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
    const sidebarSortingDisabled = $derived(isTouchDevice && DBState.db.disableMobileDragDrop);

  let sideBarMode = $state(0);
  let editMode = $state(false);
  let menuMode = $state(0);
  function reseter() {
    onNavigate();
    menuMode = 0;
    sideBarMode = 0;
    editMode = false;
    sidebarDevTool.set(false);
    QuickSettings.open = false;
    settingsOpen.set(false);
    CharEmotion.set({});
  }

  type sortTypeNormal = { type:'normal',img: string, index: number, name:string }
  type sortType =  sortTypeNormal|{type:'folder',settings:CharacterFolder,folder:sortTypeNormal[],id:string, name:string, color:string}
  let charImages: sortType[] = $state([]);
  // Recently interacted characters for the home sidebar. Character-level
  // `lastInteraction` is already in memory (no chat hydration needed), so this
  // sort is cheap; the $derived is only read while on the home screen.
  let recentChars = $derived(
    DBState.db.characters
      .flatMap((c, index) => !c.trashTime && c.lastInteraction > 0
        ? [{ index, name: c.name, image: c.image, lastInteraction: c.lastInteraction }]
        : [])
      .sort((a, b) => b.lastInteraction - a.lastInteraction)
  );
  let sidebarScrollElement: HTMLDivElement | null = $state(null);
  const recentChatsIncrementalList = createIncrementalList({
    pageSize: 12,
    rootMargin: '160px 0px',
    getRoot: () => sidebarScrollElement,
  });
  const observeRecentChatsSentinel = recentChatsIncrementalList.observeSentinel;
  let recentSearchQuery = $state("");
  let filteredRecentChars = $derived.by(() => {
    const query = recentSearchQuery.trim().toLocaleLowerCase();
    if (!query) return recentChars;
    return recentChars.filter((character) =>
      (character.name ?? "").toLocaleLowerCase().includes(query)
    );
  });
  let displayedRecentChars = $derived(recentChatsIncrementalList.slice(filteredRecentChars));
  let hasMoreRecentChars = $derived(recentChatsIncrementalList.hasMore(filteredRecentChars.length));

  $effect(() => {
    recentSearchQuery;
    recentChatsIncrementalList.reset();
  });
  let IconRounded = $state(false)
  let sidebarMenuOrder = $derived(DBState.db.sidebarMenuOrder ?? DEFAULT_SIDEBAR_MENU_ORDER)
  let sidebarMenuHidden = $derived(DBState.db.sidebarMenuHidden ?? [])
  let sidebarMenuHiddenSet = $derived(new Set(sidebarMenuHidden))
  let sidebarMenuPluginsByKey = $derived(new Map(
    additionalHamburgerMenu.map((menu) => [menu.sidebarKey ?? pluginSidebarMenuKey(menu.id), menu])
  ))
  let sidebarMenuPluginKeys = $derived([...sidebarMenuPluginsByKey.keys()])
  let visibleSidebarMenuOrder = $derived(
    getVisibleSidebarMenuOrder(sidebarMenuOrder, sidebarMenuPluginKeys, editMode, sidebarMenuHidden)
  )
  let displayedSidebarMenuOrder = $derived(
    getSidebarMenuDisplayOrder(visibleSidebarMenuOrder, !!DBState.db.hamburgerButtonBottom)
  )
  let openFolders:string[] = $state([])
  let characterListElement: HTMLDivElement | undefined = $state()
  let sidebarSortElement: HTMLDivElement | undefined = $state()
  let mergeTargetId: string | null = $state(null)
  let folderDropTargetId: string | null = $state(null)
  const sidebarDragController = createSidebarDragController({
    root: () => sidebarSortElement,
    onTargetChange: (target: SidebarDropTarget | null) => {
      mergeTargetId = target?.kind === 'merge' ? target.id : null
      folderDropTargetId = target?.kind === 'folder' ? target.id : null
    },
  })
  const sidebarSortableBehavior = sidebarDragController.sortableOptions
  const sidebarRootSortableOptions = {
    ...sidebarSortableBehavior,
    group: {
      name: SIDEBAR_SORTABLE_GROUP,
      pull: true,
      put: true,
    },
  }
  const sidebarFolderSortableOptions = {
    ...sidebarSortableBehavior,
    group: {
      name: SIDEBAR_SORTABLE_GROUP,
      pull: true,
      put: (_to: unknown, _from: unknown, dragged: HTMLElement) => dragged.dataset.sidebarKind === 'character',
    },
  }
  interface Props {
    openGrid?: any;
    onNavigate?: () => void;
    hidden?: boolean;
  }

  let { openGrid = () => {}, onNavigate = () => {}, hidden = false }: Props = $props();

  sideBarClosing.set(false)

  $effect(() => {
    let newCharImages: sortType[] = [];
    const idObject = getCharacterIndexObject()
    const hiddenIds = new Set(DBState.db.nodeOnlyHiddenCharacterIds ?? [])
    for (const id of DBState.db.characterOrder) {
      if(typeof(id) === 'string'){
        if (hiddenIds.has(id)) continue
        const index = idObject[id] ?? -1
        if(index !== -1){
          const cha = DBState.db.characters[index]
          newCharImages.push({
            img:cha.image ?? "",
            index:index,
            type: "normal",
            name: cha.name
          });
        }
      }
      else{
        const folder = id
        let folderCharImages: sortTypeNormal[] = []
        for(const id of folder.data){
          if (hiddenIds.has(id)) continue
          const index = idObject[id] ?? -1
          if(index !== -1){
            const cha = DBState.db.characters[index]
            folderCharImages.push({
              img:cha.image ?? "",
              index:index,
              type: "normal",
              name: cha.name
            });
          }
        }
        newCharImages.push({
          settings: folder,
          folder: folderCharImages,
          type: "folder",
          id: folder.id,
          name: folder.name,
          color: folder.color,
        });
      }
    }
    if (!isEqual(charImages, newCharImages)) {
      charImages = newCharImages;
    }
    if(IconRounded !== DBState.db.roundIcons){
      IconRounded = DBState.db.roundIcons
    }
  })

  $effect(() => {
    const nextOrder = appendNewPluginMenuItems(sidebarMenuOrder, sidebarMenuPluginKeys)
    if (!isEqual(nextOrder, sidebarMenuOrder)) {
      DBState.db.sidebarMenuOrder = nextOrder
    }
  })

  function pluginMenuForKey(key: string) {
    return sidebarMenuPluginsByKey.get(key)
  }

  function reorderSidebarMenu(orderedKeys: string[]) {
    const storedDirection = getSidebarMenuDisplayOrder(orderedKeys, !!DBState.db.hamburgerButtonBottom)
    DBState.db.sidebarMenuOrder = mergeVisibleSidebarMenuOrder(sidebarMenuOrder, storedDirection)
  }

  function addSidebarMenuDivider() {
    DBState.db.sidebarMenuOrder = [
      ...sidebarMenuOrder,
      dividerSidebarMenuKey(v4()),
    ]
  }

  function removeSidebarMenuDivider(key: string, event: MouseEvent) {
    event.preventDefault()
    if (!editMode || !isSidebarMenuDivider(key)) return
    DBState.db.sidebarMenuOrder = sidebarMenuOrder.filter((item) => item !== key)
  }

  function isSidebarMenuHidden(key: string) {
    return sidebarMenuHiddenSet.has(key)
  }

  function toggleSidebarMenuVisibility(key: string, event: MouseEvent) {
    if (!editMode) return
    event.preventDefault()
    DBState.db.sidebarMenuHidden = isSidebarMenuHidden(key)
      ? sidebarMenuHidden.filter((item) => item !== key)
      : [...sidebarMenuHidden, key]
  }

  function toggleSidebarMenuEdit(event: MouseEvent) {
    event.preventDefault()
    event.stopPropagation()
    if (menuMode !== 1) return
    editMode = !editMode
  }

  function openHome() {
    if (editMode) return
    reseter()
    selectedCharID.set(-1)
    OpenRealmStore.set(false)
  }

  function openCharacters() {
    if (editMode) return
    reseter()
    openGrid()
  }

  function openSettings() {
    if (editMode) return
    if ($settingsOpen) {
      reseter()
      settingsOpen.set(false)
    } else {
      reseter()
      settingsOpen.set(true)
    }
  }


  function commitSidebarOrder(nextOrder: typeof DBState.db.characterOrder) {
    DBState.db.characterOrder = nextOrder
    checkCharOrder()
  }

  function syncSidebarOrderUnlessDropping(_orderedKeys: string[], event: SortableEvent) {
    if (!sidebarSortElement || !sidebarDragController.shouldSyncOrder(event)) return
    commitSidebarOrder(readSidebarOrderFromDom(sidebarSortElement, DBState.db.characterOrder, new Set(DBState.db.nodeOnlyHiddenCharacterIds ?? [])))
  }

  function finishSidebarDrag(sourceId: string, event: SortableEvent) {
    const target = sidebarDragController.end(event)
    const nextOrder = applySidebarDrop(DBState.db.characterOrder, sourceId, target, () => ({
      id: v4(),
      name: SIDEBAR_DEFAULT_FOLDER_NAME,
      color: '',
    }))
    if (nextOrder) commitSidebarOrder(nextOrder)
    suppressNextClick = true
    requestAnimationFrame(() => { suppressNextClick = false })
  }

  function startSidebarDrag(sourceId: string, event: SortableEvent) {
    sidebarDragController.start(sourceId, event)
  }

  onDestroy(() => {
    sidebarDragController.destroy()
    sidebarDevTool.set(false)
  })

  function scrollToActiveCharacter() {
    const selectedId = $selectedCharID
    if (selectedId === -1) return
    
    const characterId = DBState.db.characters[selectedId]?.chaId
    if (!characterId) return
    
    let targetFolderId: string | null = null
    
    for (const item of charImages) {
      if (item.type === 'folder') {
        const foundChar = item.folder.find(c => 
          DBState.db.characters[c.index]?.chaId === characterId
        )
        if (foundChar) {
          targetFolderId = item.id
          break
        }
      }
    }
    
    if (targetFolderId && !openFolders.includes(targetFolderId)) {
      openFolders.push(targetFolderId)
      openFolders = openFolders
    }
    
    setTimeout(() => {
      const activeElement = characterListElement?.querySelector<HTMLElement>(`[data-char-id="${characterId}"]`)
      if (characterListElement && activeElement) {
        const listRect = characterListElement.getBoundingClientRect()
        const activeRect = activeElement.getBoundingClientRect()

        // Keep the scroll confined to the character list. scrollIntoView() can
        // also scroll page-level ancestors and displace the chat input layout.
        characterListElement.scrollTo({
          top: characterListElement.scrollTop + activeRect.top - listRect.top,
          behavior: 'smooth'
        })
      }
    }, 100)
  }

  $effect(() => {
    if (typeof window === 'undefined') return
    
    const handler = () => {
      scrollToActiveCharacter()
    }
    
    window.addEventListener('scrollToActiveCharacter', handler)
    
    return () => {
      window.removeEventListener('scrollToActiveCharacter', handler)
    }
  })

  let suppressNextClick = false
</script>

<div
  class="sidebar-layout-slot h-full shrink-0"
  class:overflow-hidden={!editMode}
  class:overflow-visible={editMode}
  class:sidebar-menu-edit-active={editMode}
  class:dynamic-sidebar-slot={$DynamicGUI}
  class:risu-sidebar-slot={!$sideBarClosing}
  class:risu-sidebar-slot-close={$sideBarClosing}
  class:hidden={hidden}
  onanimationend={(event) => {
    if (event.currentTarget !== event.target || !$sideBarClosing) {
      return;
    }
    $sideBarClosing = false;
    sideBarStore.set(false);
  }}
>
<div
  class="sidebar-motion-panel h-full flex shrink-0"
  class:dynamic-sidebar-panel={$DynamicGUI}
  class:sidebar-menu-editing={editMode}
>
<div
  class="h-full w-20 min-w-20 flex-col items-center bg-lightbg text-maintext shadow-lg relative rs-sidebar"
  class:risu-layer-chrome={!editMode}
  class:sidebar-menu-bottom={DBState.db.hamburgerButtonBottom}
  class:max-xs:hidden={$leftBarCollapsed}
  class:flex={!hidden}
>
  <div
    class="sidebar-controls"
    class:risu-layer-blocking={editMode}
    class:bg-lightbg={editMode}
  >
    <IconButtonGroup size="xl" direction="vertical" className="sidebar-control-buttons w-full">
      <button
        class="flex h-8 min-h-8 w-14 min-w-14 text-themewhite items-center justify-center rounded-md bg-subtext transition-colors hover:bg-lightborderc"
        class:cursor-pointer={!editMode}
        class:cursor-default={editMode}
        class:max-xs:hidden={$leftBarCollapsed}
        aria-disabled={editMode}
        onclick={() => {
          if (editMode) return
          menuMode = 1 - menuMode;
        }}
        oncontextmenu={toggleSidebarMenuEdit}
      >
        <ListIcon />
      </button>

      {#if !DBState.db.hideLeftBarCollapseButton}
        <button
          class="hidden max-xs:flex h-8 min-h-8 w-14 min-w-14 cursor-pointer items-center justify-center rounded-md border border-darkborderc text-maintext transition-colors risu-interactive-border"
          aria-label="Collapse sidebar"
          onclick={() => leftBarCollapsed.set(true)}
        >
          <ChevronsLeftIcon />
        </button>
      {/if}
    </IconButtonGroup>
  </div>

  <div class="sidebar-content relative flex min-h-0 w-full flex-1">

    {#if menuMode === 1}
      <SortableList
        disabled={!editMode}
        className="absolute left-0 w-20 min-w-20 flex max-h-full bg-lightbg flex-col items-center gap-2 {editMode ? 'risu-layer-blocking' : 'z-20'} py-4 overflow-x-hidden overflow-y-auto hamburger-menu"
        draggable="[data-sidebar-menu-key]"
        dataAttribute="data-sidebar-menu-key"
        onReorder={reorderSidebarMenu}
      >
          {#if editMode && DBState.db.hamburgerButtonBottom}
            <div class="no-sort mt-1 flex items-center justify-center" data-sortable-no-scale>
              <IconButton
                size="default"
                title={language.sidebarMenuAddDivider}
                aria-label={language.sidebarMenuAddDivider}
                onclick={addSidebarMenuDivider}
              >
                <PlusIcon />
              </IconButton>
            </div>
          {/if}
          {#each displayedSidebarMenuOrder as menuKey (menuKey)}
            {#if isSidebarMenuDivider(menuKey)}
              <div
                class="flex h-3 min-h-3 w-full shrink-0 items-center justify-center"
                class:sidebar-menu-edit-item={editMode}
                role="separator"
                aria-orientation="horizontal"
                data-sidebar-menu-key={menuKey}
                data-sortable-no-scale
                title={editMode ? language.sidebarMenuRemoveDivider : undefined}
                oncontextmenu={(event) => removeSidebarMenuDivider(menuKey, event)}
              >
                <div class="h-px w-10 bg-selected"></div>
              </div>
            {:else}
              <div
                class:sidebar-menu-edit-item={editMode}
                role="listitem"
                data-sidebar-menu-key={menuKey}
                data-sortable-no-scale
                title={editMode
                  ? (isSidebarMenuHidden(menuKey) ? language.sidebarMenuShowIcon : language.sidebarMenuHideIcon)
                  : undefined}
                oncontextmenu={(event) => toggleSidebarMenuVisibility(menuKey, event)}
              >
                <div class:opacity-40={editMode && isSidebarMenuHidden(menuKey)}>
                  {#if menuKey === SIDEBAR_MENU_HOME}
                    <BarIcon onClick={openHome}>
                      <HomeIcon />
                    </BarIcon>
                  {:else if menuKey === SIDEBAR_MENU_CHARACTERS}
                    <BarIcon onClick={openCharacters}>
                      <LayoutGridIcon />
                    </BarIcon>
                  {:else if menuKey === SIDEBAR_MENU_BOOKMARKS}
                    <BarIcon onClick={() => {
                      if (editMode) return
                      reseter()
                      bookmarkListOpen.set(true)
                    }}>
                      <BookmarkCheckIcon />
                    </BarIcon>
                  {:else if menuKey === SIDEBAR_MENU_SETTINGS}
                    <BarIcon onClick={openSettings}>
                      <SettingsIcon />
                    </BarIcon>
                  {:else}
                    {@const menu = pluginMenuForKey(menuKey)}
                    {#if menu}
                      <BarIcon
                        onClick={() => {
                          if (editMode) return
                          reseter()
                          menu.callback()
                        }}
                      >
                        <PluginDefinedIcon ico={menu} />
                      </BarIcon>
                    {/if}
                  {/if}
                </div>
              </div>
            {/if}
          {/each}
          {#if editMode && !DBState.db.hamburgerButtonBottom}
            <div class="no-sort mt-1 flex items-center justify-center" data-sortable-no-scale>
              <IconButton
                size="default"
                title={language.sidebarMenuAddDivider}
                aria-label={language.sidebarMenuAddDivider}
                onclick={addSidebarMenuDivider}
              >
                <PlusIcon />
              </IconButton>
            </div>
          {/if}
      </SortableList>
    {/if}

    <div
      bind:this={characterListElement}
      class="character-list flex min-h-0 w-full grow flex-col items-center overflow-x-hidden overflow-y-auto pr-0"
      class:max-xs:hidden={$leftBarCollapsed}
      role="list"
      inert={editMode}
    >
    <SortableList
      bind:element={sidebarSortElement}
      disabled={sidebarSortingDisabled}
      className="sidebar-character-root flex w-full shrink-0 flex-col items-center gap-4 py-4"
      draggable="[data-sidebar-order-key]"
      dataAttribute="data-sidebar-order-key"
      options={sidebarRootSortableOptions}
      onReorder={syncSidebarOrderUnlessDropping}
      onDragStart={startSidebarDrag}
      onDragEnd={finishSidebarDrag}
    >
    {#each charImages as char, ind}
      <div
        class="flex flex-col items-center"
        data-sidebar-order-key={char.type === 'normal' ? DBState.db.characters[char.index]?.chaId : char.id}
        data-sidebar-kind={char.type === 'normal' ? 'character' : 'folder'}
        data-sortable-no-scale
      >
      <div class="group relative flex items-center"
        role="listitem"
      >
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div
            role="button" tabindex="0"
            onclick={() => {
              if(suppressNextClick) return
              if(char.type === "normal"){
                changeChar(char.index, {reseter});
              }
            }}
            onkeydown={(e) => {
              if (e.key === "Enter") {
                if(char.type === "normal"){
                  changeChar(char.index, {reseter});
                }
              }
            }}
          >
          {#if char.type === 'normal'}
            <SidebarAvatar 
              src={char.img ? getCharImage(char.img, "plain") : ""}
              size={String(SIDEBAR_ROOT_ITEM_SIZE)}
              rounded={IconRounded} 
              name={char.name}
              chaId={DBState.db.characters[char.index]?.chaId}
              selected={$selectedCharID === char.index && sideBarMode !== 1}
              mergeTarget={mergeTargetId === DBState.db.characters[char.index]?.chaId}
            />
          {:else if char.type === "folder"}
            {#key char.color}
            {#key char.name}
            <FolderAvatar folder={char.settings} expanded={openFolders.includes(char.id)} size={String(SIDEBAR_ROOT_ITEM_SIZE)}
              selected={sideBarMode !== 1 && char.folder.some(folderChar => folderChar.index === $selectedCharID)}
              mergeTarget={folderDropTargetId === char.id}
              oncontextmenu={(e) => {
                e.preventDefault()
                void openSidebarFolderMenu(char.id)
              }}
              onClick={() => {
                if(suppressNextClick) return
                if(char.type !== 'folder'){
                  return
                }
                if(openFolders.includes(char.id)){
                  openFolders.splice(openFolders.indexOf(char.id), 1)
                }
                else{
                  openFolders.push(char.id)
                }
                openFolders = openFolders
              }} />

            {/key}
            {/key}
          {/if}
        </div>
      </div>
      {#if char.type === 'folder' && openFolders.includes(char.id)}
        {#key char.color}
        <div class="mt-1 flex flex-col items-center">
          <SortableList
            containerKey={char.id}
            disabled={sidebarSortingDisabled}
            className="sidebar-folder-characters flex flex-col items-center gap-3 py-2"
            draggable="[data-sidebar-order-key]"
            dataAttribute="data-sidebar-order-key"
            options={sidebarFolderSortableOptions}
            onReorder={syncSidebarOrderUnlessDropping}
            onDragStart={startSidebarDrag}
            onDragEnd={finishSidebarDrag}
          >
          {#each char.folder as char2, ind}
              <div class="group relative flex items-center z-10"
              role="listitem"
              data-sidebar-order-key={DBState.db.characters[char2.index]?.chaId}
              data-sidebar-kind="character"
              data-sortable-no-scale
            >
              <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
              <div
                  role="button" tabindex="0"
                  onclick={() => {
                    if(suppressNextClick) return
                    if(char2.type === "normal"){
                      changeChar(char2.index, {reseter});
                    }
                  }}
                  onkeydown={(e) => {
                    if (e.key === "Enter") {
                      if(char2.type === "normal"){
                        changeChar(char2.index, {reseter});
                      }
                    }
                  }}
                >
                <SidebarAvatar 
                  src={char2.img ? getCharImage(char2.img, "plain") : ""}
                  size={String(SIDEBAR_FOLDER_ITEM_SIZE)}
                  rounded={IconRounded} 
                  name={char2.name}
                  chaId={DBState.db.characters[char2.index]?.chaId}
                  selected={$selectedCharID === char2.index && sideBarMode !== 1}
                />
              </div>
            </div>
          {/each}
          </SortableList>
        </div>
        {/key}
      {/if}
      </div>
    {/each}
    </SortableList>
    <div class="sidebar-character-add flex shrink-0 flex-col items-center gap-2 px-2">
      <Button
        variant="outline"
        size="icon-lg"
        className="size-14 border-dashed text-subtext opacity-75 {IconRounded ? 'rounded-full' : ''}"
        onclick={() => addCharacter({reseter})}
      >
        <PlusIcon size={20} />
      </Button>
    </div>
    </div>
  </div>
</div>

<div
  class="setting-area risu-layer-chrome h-full max-xs:relative flex-col overflow-y-auto overflow-x-hidden bg-darkbg py-6 text-maintext max-h-full"
  bind:this={sidebarScrollElement}
  class:w-96={$sideBarSize === 0}
  class:w-110={$sideBarSize === 1}
  class:w-124={$sideBarSize === 2}
  class:w-138={$sideBarSize === 3}
  class:min-w-96={!$DynamicGUI && $sideBarSize === 0}
  class:min-w-110={!$DynamicGUI && $sideBarSize === 1}
  class:min-w-124={!$DynamicGUI && $sideBarSize === 2}
  class:min-w-138={!$DynamicGUI && $sideBarSize === 3}
  class:px-2={$DynamicGUI}
  class:px-4={!$DynamicGUI}
  class:hidden={hidden}
  class:flex={!hidden}
>
  <button
    class="flex w-full justify-end text-maintext"
    onclick={async () => {
      if($sideBarClosing){
        return
      }
      $sideBarClosing = true;
    }}
  >
    <!-- <button class="border-none bg-transparent p-0 text-maintext"><X /></button> -->
  </button>
  {#if $leftBarCollapsed}
    <button
      class="hidden max-xs:flex absolute top-3 left-0 h-12 w-12 border-r border-b border-t border-darkborderc rounded-r-md bg-darkbg risu-interactive-border transition-colors items-center justify-center text-maintext opacity-50 hover:opacity-90 z-20"
      aria-label="Expand sidebar"
      onclick={() => leftBarCollapsed.set(false)}
    >
      <ArrowRightIcon />
    </button>
  {/if}
  {#if sideBarMode === 0}
    {#if $selectedCharID < 0 || $settingsOpen}
      <span class="block text-base font-semibold text-maintext mt-2">{language.recentChatsTitle}</span>
      <div class="flex items-center justify-between gap-2 mt-2">
        <span class="text-sm text-subtext">{language.hideRecentChats}</span>
        <Switch
          checked={!!DBState.db.nodeOnlyHideRecentChats}
          onCheckedChange={(v) => (DBState.db.nodeOnlyHideRecentChats = v)}
        />
      </div>
      {#if DBState.db.nodeOnlyHideRecentChats}
        <!-- list hidden by user preference -->
      {:else if recentChars.length === 0}
        <EmptyState title={language.noRecentChatsDesc} description="" className="mt-2" />
      {:else}
        <div class="relative mt-2">
          <SearchIcon class="pointer-events-none absolute left-2.5 top-1/2 z-10 size-4 -translate-y-1/2 text-subtext" />
          <Input
            bind:value={recentSearchQuery}
            type="search"
            autocomplete="off"
            aria-label={language.recentChatsSearchPlaceholder}
            placeholder={language.recentChatsSearchPlaceholder}
            className="h-9 min-h-9 pl-8 text-sm"
          />
        </div>
        {#if filteredRecentChars.length === 0}
          <EmptyState className="mt-2" />
        {:else}
        <HorizontalMasonry itemCount={displayedRecentChars.length} className="mt-2">
          {#snippet children(index)}
            {@const rc = displayedRecentChars[index]}
            <CharacterMasonryIcon
              src={rc.image ? getCharImage(rc.image, "plain") : ""}
              name={rc.name || "Unnamed"}
              subtitle={makeAgoText(rc.lastInteraction)}
              onclick={() => changeChar(rc.index, {reseter})}
            />
          {/snippet}
        </HorizontalMasonry>
        {#if hasMoreRecentChars}
          <div
            class="h-px w-full"
            aria-hidden="true"
            use:observeRecentChatsSentinel={filteredRecentChars.length}
          ></div>
        {/if}
        {/if}
      {/if}
    {:else}
      <nav class="sidebar-mode-switch" aria-label={language.sidebarView}>
        <IconButtonGroup size="sm" className="contents">
        <button
          type="button"
          class="sidebar-mode-button sidebar-mode-tab"
          class:active={!$botMakerMode && !$sidebarDevTool}
          aria-current={!$botMakerMode && !$sidebarDevTool ? "page" : undefined}
          onclick={() => {
            $sidebarDevTool = false
            QuickSettings.open = false
            botMakerMode.set(false)
          }}
        >
          <MessageSquareIcon />
          <span>{language.Chat}</span>
        </button>
        <button
          type="button"
          class="sidebar-mode-button sidebar-mode-tab"
          class:active={$botMakerMode}
          aria-current={$botMakerMode ? "page" : undefined}
          onclick={() => {
            $sidebarDevTool = false
            botMakerMode.set(true)
          }}
        >
          <User2Icon />
          <span>{language.character}</span>
        </button>
        </IconButtonGroup>
      </nav>
      {#if $botMakerMode && QuickSettings.open}
        <QuickSettingsGui />
      {:else if $botMakerMode || $sidebarDevTool}
        <CharConfigHeader
          devTool={$sidebarDevTool}
          onDevToolChange={(active) => {
            $sidebarDevTool = active
            if(active) botMakerMode.set(true)
          }}
        />
        {#if $sidebarDevTool}
          <DevTool />
        {:else}
          <CharConfig />
        {/if}
      {:else}
        <SideChatList bind:chara={ DBState.db.characters[$selectedCharID]} />
      {/if}
    {/if}
  {/if}
</div>
</div>
{#if editMode}
  <div
    class="risu-modal-backdrop risu-layer-overlay sidebar-menu-edit-backdrop"
    role="button"
    tabindex="0"
    aria-label={language.sidebarMenuExitEdit}
    onclick={() => (editMode = false)}
    onkeydown={(event) => {
      if (event.key === 'Enter' || event.key === 'Escape') editMode = false
    }}
  ></div>
{/if}
</div>

{#if $DynamicGUI}
    <div role="button" tabindex="0" class="risu-modal-backdrop sidebar-dismiss-area"
      class:hidden={hidden} onclick={() => {
      if($sideBarClosing){
        return
      }
      $sideBarClosing = true;
    }}
      onkeydown={(e)=>{
        if(e.key === 'Enter'){
            e.currentTarget.click()
        }
      }}
      class:sidebar-dark-animation={!$sideBarClosing}
      class:sidebar-dark-close-animation={$sideBarClosing}>

    </div>

{/if}

<style>
  :global(.sidebar-character-root .risu-ghost-item[data-sidebar-kind="character"]),
  :global(.sidebar-sortable-fallback[data-sidebar-kind="character"]) {
    width: var(--sidebar-drag-size) !important;
    height: var(--sidebar-drag-size) !important;
    min-width: var(--sidebar-drag-size) !important;
  }

  :global(.sidebar-character-root .risu-ghost-item .avatar),
  :global(.sidebar-character-root .risu-ghost-item .avatar-tile),
  :global(.sidebar-sortable-fallback .avatar),
  :global(.sidebar-sortable-fallback .avatar-tile) {
    width: var(--sidebar-drag-size) !important;
    height: var(--sidebar-drag-size) !important;
    min-width: var(--sidebar-drag-size) !important;
  }

  :global(.sidebar-sortable-fallback) {
    opacity: 0.82 !important;
  }

  .sidebar-mode-switch {
    position: relative;
    bottom: 1.5rem;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    width: 100%;
    height: 2rem;
    min-height: 2rem;
    overflow: hidden;
    border-bottom: 1px solid color-mix(in srgb, var(--risu-theme-darkborderc) 75%, transparent);
  }

  .sidebar-mode-button {
    position: relative;
    display: flex;
    min-width: 0;
    height: 100%;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    padding: 0 0.5rem;
    border: 0;
    color: var(--risu-theme-subtext);
    font-size: 0.8rem;
    font-weight: 500;
    line-height: 1;
    white-space: nowrap;
    transition: color 150ms ease;
  }

  .sidebar-mode-button:is(:hover, :focus-visible):not(.active) {
    color: var(--risu-theme-maintext);
  }

  .sidebar-mode-button.active {
    color: var(--risu-theme-maintext);
    background: linear-gradient(
      to top,
      color-mix(in srgb, var(--risu-theme-primary) 16%, transparent) 0%,
      color-mix(in srgb, var(--risu-theme-primary) 7%, transparent) 45%,
      transparent 100%
    );
  }

  .sidebar-mode-button.active::after {
    content: "";
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    height: 2px;
    background: var(--risu-theme-primary);
    box-shadow: 0 -4px 12px color-mix(in srgb, var(--risu-theme-primary) 38%, transparent);
  }

  .sidebar-mode-button :global(svg) {
    flex: none;
  }

  @media (max-width: 420px) {
    .sidebar-mode-tab {
      gap: 0.3rem;
      padding-inline: 0.35rem;
      font-size: 0.75rem;
    }
  }

  .sidebar-layout-slot {
    --sidebar-rail-size: 5rem;
    --sidebar-natural-size: calc(var(--sidebar-size) + var(--sidebar-rail-size));
    --sidebar-total-size: var(--sidebar-natural-size);
    width: var(--sidebar-total-size);
    min-width: var(--sidebar-total-size);
  }

  .sidebar-motion-panel {
    width: var(--sidebar-total-size);
    min-width: var(--sidebar-total-size);
    transform: translateX(0);
  }
  .sidebar-motion-panel.sidebar-menu-editing {
    transform: none;
  }

  .dynamic-sidebar-slot {
    --sidebar-dismiss-size: 3rem;
    --sidebar-total-size: min(
      var(--sidebar-natural-size),
      calc(100vw - var(--sidebar-dismiss-size))
    );
  }

  @keyframes sidebar-slot-open {
    from {
      width: 0;
      min-width: 0;
    }
    to {
      width: var(--sidebar-total-size);
      min-width: var(--sidebar-total-size);
    }
  }

  @keyframes sidebar-slot-close {
    from {
      width: var(--sidebar-total-size);
      min-width: var(--sidebar-total-size);
    }
    to {
      width: 0;
      min-width: 0;
    }
  }

  @keyframes sidebar-panel-open {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(0);
    }
  }

  @keyframes sidebar-panel-close {
    from {
      transform: translateX(0);
    }
    to {
      transform: translateX(-100%);
    }
  }

  @keyframes sidebar-dim-open {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  @keyframes sidebar-dim-close {
    from {
      opacity: 1;
    }
    45%,
    to {
      opacity: 0;
    }
  }

  .risu-sidebar-slot:not(.dynamic-sidebar-slot) {
    animation: sidebar-slot-open var(--risu-animation-speed) ease;
  }

  .risu-sidebar-slot:not(.dynamic-sidebar-slot) .sidebar-motion-panel {
    animation: sidebar-panel-open var(--risu-animation-speed) ease;
  }

  .risu-sidebar-slot-close:not(.dynamic-sidebar-slot) {
    animation: sidebar-slot-close var(--risu-animation-speed) ease forwards;
  }

  .risu-sidebar-slot-close:not(.dynamic-sidebar-slot) .sidebar-motion-panel {
    animation: sidebar-panel-close var(--risu-animation-speed) ease forwards;
  }

  .dynamic-sidebar-slot {
    position: absolute;
    inset: 0 auto 0 0;
    z-index: 1;
    overflow: hidden;
    transform: translateX(0);
  }

  .dynamic-sidebar-slot.risu-sidebar-slot {
    animation: sidebar-panel-open var(--risu-animation-speed) ease;
  }

  .dynamic-sidebar-slot.risu-sidebar-slot-close {
    animation: sidebar-panel-close var(--risu-animation-speed) ease forwards;
  }

  .sidebar-dismiss-area {
    z-index: 0;
    min-width: 0;
    touch-action: manipulation;
    will-change: opacity;
  }

  .sidebar-dark-animation {
    animation: sidebar-dim-open var(--risu-animation-speed) ease;
    opacity: 1;
  }

  .sidebar-dark-close-animation {
    animation: sidebar-dim-close var(--risu-animation-speed) ease forwards;
    opacity: 0;
  }
  :global(.hamburger-menu) {
    top: 0;
    border-radius: 0 0 0.375rem 0.375rem;
    scrollbar-width: none;
    overscroll-behavior: none;
  }
  .rs-sidebar {
    --sidebar-menu-gap: 1rem;
  }
  .rs-sidebar:not(.sidebar-menu-bottom) :global(.hamburger-menu) {
    top: calc(-1 * var(--sidebar-menu-gap));
    padding-top: var(--sidebar-menu-gap);
  }
  .rs-sidebar:not(.sidebar-menu-bottom) :global(.sidebar-character-root) {
    padding-top: 0;
  }
  :global(.sidebar-menu-edit-item) {
    cursor: grab;
  }
  :global(.sidebar-menu-edit-item:active) {
    cursor: grabbing;
  }
  .sidebar-controls {
    --sidebar-control-edge-gap: 0.5rem;
    --sidebar-control-button-gap: 0.5rem;
    display: flex;
    flex-shrink: 0;
    width: 100%;
    flex-direction: column;
    align-items: center;
    margin-bottom: var(--sidebar-menu-gap);
    padding: var(--sidebar-control-edge-gap) 0 0;
  }
  .sidebar-menu-edit-backdrop {
    width: 100vw;
  }
  .dynamic-sidebar-slot.sidebar-menu-edit-active {
    overflow: visible;
  }
  .sidebar-menu-bottom .sidebar-controls {
    order: 9999;
    margin: var(--sidebar-menu-gap) 0 0;
    padding: 0 0 var(--sidebar-control-edge-gap);
  }
  :global(.sidebar-control-buttons) {
    gap: var(--sidebar-control-button-gap);
  }
  .sidebar-menu-bottom :global(.sidebar-control-buttons) {
    flex-direction: column-reverse;
  }
  .sidebar-menu-bottom :global(.hamburger-menu) {
    top: auto;
    bottom: calc(-1 * var(--sidebar-menu-gap));
    padding-bottom: var(--sidebar-menu-gap);
    border-radius: 0.375rem 0.375rem 0 0;
  }
  .sidebar-menu-bottom :global(.sidebar-character-root) {
    padding-bottom: 0;
  }
  .sidebar-menu-bottom .sidebar-character-add {
    order: -1;
    margin-top: auto;
  }
  :global(.sidebar-character-root:empty) {
    padding-block: 0;
  }
  :global(.hamburger-menu::-webkit-scrollbar) {
    display: none;
  }
  .character-list {
    scrollbar-width: none;
  }
  .rs-sidebar:not(.sidebar-menu-bottom) .character-list::after {
    content: '';
    width: 100%;
    flex: 0 0 var(--sidebar-menu-gap);
  }
  .sidebar-menu-bottom .character-list::before {
    content: '';
    order: -2;
    width: 100%;
    flex: 0 0 var(--sidebar-menu-gap);
  }
  .character-list::-webkit-scrollbar {
    display: none;
  }

</style>
