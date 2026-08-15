<script lang="ts">
    import {
    CharEmotion,
    DynamicGUI,
    botMakerMode,
    selectedCharID,
    settingsOpen,
    sideBarClosing,
    sideBarStore,
    OpenRealmStore,
    PlaygroundStore,

    QuickSettings,

    additionalHamburgerMenu,

    leftBarCollapsed


  } from "../../ts/stores.svelte";
    import { setDatabase, type folder } from "../../ts/storage/database.svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import BarIcon from "./BarIcon.svelte";
    import {
    ShellIcon,
    Settings,
    ListIcon,
    LayoutGridIcon,
    FolderIcon,
    FolderOpenIcon,
    HomeIcon,
    MessageSquareIcon,
    PlusIcon,
    User2Icon,
    ChevronsLeft,
    ArrowRight,
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
    import ShSwitch from "../UI/GUI/ShSwitch.svelte";
    import ShSortableList from "../UI/GUI/ShSortableList.svelte";
    import type { MoveEvent } from "sortablejs";
    import BaseRoundedButton from "../UI/BaseRoundedButton.svelte";
    import { getCharacterIndexObject, makeAgoText, selectSingleFile } from "src/ts/util";
    import { v4 } from "uuid";
    import { checkCharOrder, getFileSrc, saveAsset } from "src/ts/globalApi.svelte";
    import { alertInput, alertSelect } from "src/ts/alert";
    import SideChatList from "./SideChatList.svelte";
    import { folderColorOptions } from "./folderColors";

  import { sideBarSize } from "src/ts/gui/guisize";
  import DevTool from "./DevTool.svelte";
  import CharConfigHeader from "./CharConfigHeader.svelte";
    import QuickSettingsGui from "../Others/QuickSettingsGUI.svelte";
    import PluginDefinedIcon from "../Others/PluginDefinedIcon.svelte";
    import IconButtonGroup from "../UI/GUI/IconButtonGroup.svelte";
  const isTouchDevice = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
    const sidebarSortingDisabled = $derived(isTouchDevice && DBState.db.disableMobileDragDrop);

  let sideBarMode = $state(0);
  let editMode = $state(false);
  let menuMode = $state(0);
  let devTool = $state(false)

  function reseter() {
    onNavigate();
    menuMode = 0;
    sideBarMode = 0;
    editMode = false;
    settingsOpen.set(false);
    CharEmotion.set({});
  }

  type sortTypeNormal = { type:'normal',img: string, index: number, name:string }
  type sortType =  sortTypeNormal|{type:'folder',folder:sortTypeNormal[],id:string, name:string, color:string, localOnly?:boolean, img?:string}
  let charImages: sortType[] = $state([]);
  // Recently interacted characters for the home sidebar. Character-level
  // `lastInteraction` is already in memory (no chat hydration needed), so this
  // sort is cheap; the $derived is only read while on the home screen.
  let recentChars = $derived(
    DBState.db.characters
      .map((c, index) => ({ index, name: c.name, image: c.image, lastInteraction: c.lastInteraction ?? 0 }))
      .filter((c) => c.lastInteraction > 0)
      .sort((a, b) => b.lastInteraction - a.lastInteraction)
  );
  // Progressive reveal: render `recentVisible` items, "Load more" adds 10.
  // Avoids mounting hundreds of avatar components at once (no list virtualization).
  let recentVisible = $state(10);
  let IconRounded = $state(false)
  let openFolders:string[] = $state([])
  let sidebarSortElement: HTMLDivElement | undefined = $state()
  let mergeTargetId: string | null = null
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
    for (const id of DBState.db.characterOrder) {
      if(typeof(id) === 'string'){
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
          folder: folderCharImages,
          type: "folder",
          id: folder.id,
          name: folder.name,
          color: folder.color,
          localOnly: folder.localOnly,
          img: folder.imgFile,
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


  function syncSidebarOrderFromDom() {
    if (!sidebarSortElement) return
    const existingFolders = new Map(
      DBState.db.characterOrder
        .filter((item): item is folder => typeof item !== 'string')
        .map(item => [item.id, item])
    )
    const nextOrder: (string | folder)[] = []
    const seenCharacterIds = new Set<string>()

    for (const element of sidebarSortElement.querySelectorAll<HTMLElement>(':scope > [data-sidebar-order-key]')) {
      const key = element.dataset.sidebarOrderKey
      if (!key) continue
      const existingFolder = existingFolders.get(key)
      if (existingFolder) {
        const folderContainer = element.querySelector<HTMLElement>(`:scope [data-sortable-container-key="${CSS.escape(key)}"]`)
        if (folderContainer) {
          existingFolder.data = Array.from(
            folderContainer.querySelectorAll<HTMLElement>(':scope > [data-sidebar-order-key]')
          ).map(child => child.dataset.sidebarOrderKey ?? '').filter(id => id && !seenCharacterIds.has(id))
        }
        existingFolder.data.forEach(id => seenCharacterIds.add(id))
        nextOrder.push(existingFolder)
      } else if (!seenCharacterIds.has(key)) {
        seenCharacterIds.add(key)
        nextOrder.push(key)
      }
    }

    DBState.db.characterOrder = nextOrder
    checkCharOrder()
  }

  function createFolderById(sourceId: string, targetId: string) {
    if (sourceId === targetId) return
    const order = DBState.db.characterOrder
    const sourceIndex = order.indexOf(sourceId)
    const targetIndex = order.indexOf(targetId)
    const sourceFolder = sourceIndex === -1
      ? order.find((item): item is folder => typeof item !== 'string' && item.data.includes(sourceId))
      : undefined
    if ((!sourceFolder && sourceIndex === -1) || targetIndex === -1) return
    const newFolder: folder = {
      name: "New Folder",
      data: [sourceId, targetId],
      color: "",
      id: v4(),
    }
    order[targetIndex] = newFolder
    if (sourceFolder) {
      sourceFolder.data.splice(sourceFolder.data.indexOf(sourceId), 1)
    } else {
      order.splice(sourceIndex, 1)
    }
    DBState.db.characterOrder = order
    checkCharOrder()
  }

  function moveSidebarItem(event: MoveEvent, originalEvent: Event) {
    const dragged = event.dragged as HTMLElement
    const related = event.related as HTMLElement
    if (dragged.dataset.sidebarKind === 'folder' && event.to !== sidebarSortElement) return false
    if (
      event.to === sidebarSortElement &&
      dragged.dataset.sidebarKind === 'character' &&
      related.dataset.sidebarKind === 'character'
    ) {
      const pointerY = originalEvent instanceof TouchEvent
        ? originalEvent.touches[0]?.clientY
        : (originalEvent as MouseEvent).clientY
      const rect = related.getBoundingClientRect()
      const inCenter = pointerY !== undefined && pointerY > rect.top + rect.height * 0.3 && pointerY < rect.bottom - rect.height * 0.3
      mergeTargetId = inCenter ? related.dataset.sidebarOrderKey ?? null : null
      if (inCenter) return false
    } else {
      mergeTargetId = null
    }
    return true
  }

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
      const activeElement = document.querySelector(`[data-char-id="${characterId}"]`)
      if (activeElement) {
        activeElement.scrollIntoView({ 
          behavior: 'smooth', 
          block: 'start' 
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
  class="sidebar-layout-slot h-full shrink-0 overflow-hidden"
  class:sidebar-edit-mode={editMode}
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
>
{#if DBState.db.menuSideBar}
<div
  class="h-full w-20 min-w-20 flex-col items-center bg-bgcolor text-textcolor shadow-lg relative z-30 rs-sidebar"
  class:editMode
  class:flex={!hidden}
>
<IconButtonGroup size="xl" direction="vertical" className="mt-4 w-full">
<button
  class="flex items-center justify-center py-2 flex-col gap-1 w-full"
  class:text-textcolor2={!(
    $selectedCharID < 0 &&
    $PlaygroundStore === 0 &&
    !$settingsOpen
  )}
  onclick={() => {
    reseter();
    selectedCharID.set(-1)
    PlaygroundStore.set(0)
    OpenRealmStore.set(false)
  }}
>
  <HomeIcon />
  <span class="text-xs">{language.home}</span>
</button>
<button
  class="flex items-center justify-center py-2 flex-col gap-1 w-full"
  class:text-textcolor2={!$settingsOpen}
  onclick={() => {
    if ($settingsOpen) {
      reseter();
      settingsOpen.set(false);
    } else {
      reseter();
      settingsOpen.set(true);
    }
  }}
>
  <Settings />
  <span class="text-xs">{language.settings}</span>
</button>
<button
  class="flex items-center justify-center py-2 flex-col gap-1 w-full"
  class:text-textcolor2={!(
    $selectedCharID >= 0
  )}
  onclick={() => {
    reseter();
    openGrid();

  }}
>
  <User2Icon />
  <span class="text-xs">{language.character}</span>
</button>
<button
  class="flex items-center justify-center py-2 flex-col gap-1 w-full"
  class:text-textcolor2={!(
    $selectedCharID < 0 &&
    $PlaygroundStore !== 0
  )}
  onclick={() => {
    reseter();
    selectedCharID.set(-1)
    PlaygroundStore.set(1)
  }}
>
  <ShellIcon />
  <span class="text-xs">{language.playground.playground}</span>
</button>
</IconButtonGroup>
</div>
{:else}
<div
  class="h-full w-20 min-w-20 flex-col items-center bg-bgcolor text-textcolor shadow-lg relative z-30 rs-sidebar"
  class:sidebar-menu-bottom={DBState.db.hamburgerButtonBottom}
  class:max-xs:hidden={$leftBarCollapsed}
  class:editMode
  class:flex={!hidden}
>
  <div class="sidebar-controls">
    <IconButtonGroup size="xl" direction="vertical" className="sidebar-control-buttons w-full">
      <button
        class="flex h-8 min-h-8 w-14 min-w-14 cursor-pointer text-white items-center justify-center rounded-md bg-textcolor2 transition-colors hover:bg-primary"
        class:max-xs:hidden={$leftBarCollapsed}
        onclick={() => {
          menuMode = 1 - menuMode;
        }}
      >
        <ListIcon />
      </button>

      {#if !DBState.db.hideLeftBarCollapseButton}
        <button
          class="hidden max-xs:flex h-8 min-h-8 w-14 min-w-14 cursor-pointer items-center justify-center rounded-md border border-borderc text-textcolor transition-colors hover:border-primary risu-interactive-accent"
          aria-label="Collapse sidebar"
          onclick={() => leftBarCollapsed.set(true)}
        >
          <ChevronsLeft />
        </button>
      {/if}

      {#if menuMode === 1}
        <div
          class="absolute left-0 w-20 min-w-20 flex bg-bgcolor flex-col items-center gap-2 z-20 py-4 max-h-[calc(100dvh-4rem)] overflow-x-hidden overflow-y-auto hamburger-menu"
        >
          <BarIcon
            onClick={() => {
              if ($settingsOpen) {
                reseter();
                settingsOpen.set(false);
              } else {
                reseter();
                settingsOpen.set(true);
              }
            }}
          >
            <Settings />
          </BarIcon>
          <BarIcon
            onClick={() => {
              reseter();
              selectedCharID.set(-1)
              PlaygroundStore.set(0)
              OpenRealmStore.set(false)
            }}
          >
            <HomeIcon />
          </BarIcon>
          <BarIcon
            onClick={() => {
              reseter()
              if($selectedCharID === -1 && $PlaygroundStore !== 0){
                PlaygroundStore.set(0)
                return
              }
              selectedCharID.set(-1)
              PlaygroundStore.set(1)
            }}
          >
            <ShellIcon />
          </BarIcon>
          <BarIcon
            onClick={() => {
              reseter();
              openGrid();
            }}
          >
            <LayoutGridIcon />
          </BarIcon>
          {#if additionalHamburgerMenu.length > 0}
            <div class="h-px w-10 bg-selected shrink-0"></div>
            {#each additionalHamburgerMenu as menu}
              <BarIcon
                onClick={() => {
                  reseter();
                  menu.callback();
                }}
              >
                <PluginDefinedIcon ico={menu} />
              </BarIcon>
            {/each}
          {/if}
        </div>
      {/if}
    </IconButtonGroup>
  </div>
  <div class="character-list flex grow w-full flex-col items-center overflow-x-hidden overflow-y-auto pr-0" class:max-xs:hidden={$leftBarCollapsed}>
    <ShSortableList
      bind:element={sidebarSortElement}
      disabled={sidebarSortingDisabled}
      className="sidebar-character-root flex w-full flex-col items-center gap-4 py-4"
      draggable="[data-sidebar-order-key]"
      dataAttribute="data-sidebar-order-key"
      options={{
        group: {
          name: 'sidebar-characters',
          pull: true,
          put: true,
        },
        onMove: moveSidebarItem,
      }}
      onReorder={syncSidebarOrderFromDom}
      onDragStart={() => { mergeTargetId = null }}
      onDragEnd={(sourceId) => {
        if (mergeTargetId) createFolderById(sourceId, mergeTargetId)
        mergeTargetId = null
        suppressNextClick = true
        requestAnimationFrame(() => { suppressNextClick = false })
      }}
    >
    {#each charImages as char, ind}
      <div
        class="flex flex-col items-center"
        data-sidebar-order-key={char.type === 'normal' ? DBState.db.characters[char.index]?.chaId : char.id}
        data-sidebar-kind={char.type === 'normal' ? 'character' : 'folder'}
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
              size="56" 
              rounded={IconRounded} 
              name={char.name}
              chaId={DBState.db.characters[char.index]?.chaId}
              selected={$selectedCharID === char.index && sideBarMode !== 1}
            />
          {:else if char.type === "folder"}
            {#key char.color}
            {#key char.name}
              <SidebarAvatar src="slot" size="56" rounded={IconRounded} bordered name={char.name} color={char.color} backgroundimg={char.img ? getCharImage(char.img, "plain") : ""}
              selected={sideBarMode !== 1 && char.folder.some(folderChar => folderChar.index === $selectedCharID)}
              oncontextmenu={async (e) => {
                e.preventDefault()
                const remoteVisibilityLabel = char.localOnly
                  ? language.showFolderOnRemoteAccess
                  : language.hideFolderOnRemoteAccess
                const sel = parseInt(await alertSelect([language.renameFolder,language.changeFolderColor,language.changeFolderImage,remoteVisibilityLabel,language.cancel]))
                if(sel === 0){
                  const v = await alertInput(language.changeFolderName, [], char.name)
                  const db = DBState.db
                  if(v){
                    const oder = db.characterOrder[ind]
                    if(typeof(oder) === 'string'){
                      return
                    }
                    oder.name = v
                    db.characterOrder[ind] = oder
                  }
                }
                else if(sel === 1){
                  const colorSelection = parseInt(await alertSelect(
                    folderColorOptions.map(({ label }) => label)
                  ))
                  const selectedColor = folderColorOptions[colorSelection]?.value
                  if(!selectedColor){
                    return
                  }
                  const db = DBState.db
                  const oder = db.characterOrder[ind]
                  if(typeof(oder) === 'string'){
                    return
                  }
                  oder.color = selectedColor
                  db.characterOrder[ind] = oder
                }
                else if(sel === 2) {
                  const sel = parseInt(await alertSelect(['Reset to Default Image', 'Select Image File']))
                  const db = DBState.db
                  const oder = db.characterOrder[ind]
                  if(typeof(oder) === 'string'){
                    return
                  }

                  switch (sel) {
                    case 0:
                      oder.imgFile = null
                      oder.img = ''
                      break;
                  
                    case 1:
                      const folderImage = await selectSingleFile([
                        'png',
                        'jpg',
                        'webp',
                      ])

                      if(!folderImage) {
                        return
                      }

                      const folderImageData = await saveAsset(folderImage.data)

                      oder.imgFile = folderImageData
                      oder.img = await getFileSrc(folderImageData)
                      db.characterOrder[ind] = oder
                      break;
                  }
                }
                else if(sel === 3) {
                  const db = DBState.db
                  const oder = db.characterOrder[ind]
                  if(typeof(oder) === 'string'){
                    return
                  }
                  oder.localOnly = !oder.localOnly
                  db.characterOrder[ind] = oder
                }
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
              }}>
                {#if DBState.db.showFolderName}
                  <div class="h-full w-full flex justify-center items-center">
                    <span class="hyphens-auto truncate font-bold">{char.name}</span>
                  </div>
                {:else if openFolders.includes(char.id)}
                  <FolderOpenIcon />
                {:else}
                  <FolderIcon />
                {/if}
              </SidebarAvatar>
            {/key}
            {/key}
          {/if}
        </div>
      </div>
      {#if char.type === 'folder' && openFolders.includes(char.id)}
        {#key char.color}
        <div class="mt-1 flex flex-col items-center">
          <ShSortableList
            containerKey={char.id}
            disabled={sidebarSortingDisabled}
            className="sidebar-folder-characters flex flex-col items-center gap-3 py-2"
            draggable="[data-sidebar-order-key]"
            dataAttribute="data-sidebar-order-key"
            options={{
              group: {
                name: 'sidebar-characters',
                pull: true,
                put: (_to, _from, dragged) => (dragged as HTMLElement).dataset.sidebarKind === 'character',
              },
              onMove: moveSidebarItem,
            }}
            onReorder={syncSidebarOrderFromDom}
            onDragEnd={() => {
              suppressNextClick = true
              requestAnimationFrame(() => { suppressNextClick = false })
            }}
          >
          {#each char.folder as char2, ind}
              <div class="group relative flex items-center z-10"
              role="listitem"
              data-sidebar-order-key={DBState.db.characters[char2.index]?.chaId}
              data-sidebar-kind="character"
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
                  size="48"
                  rounded={IconRounded} 
                  name={char2.name}
                  chaId={DBState.db.characters[char2.index]?.chaId}
                  selected={$selectedCharID === char2.index && sideBarMode !== 1}
                />
              </div>
            </div>
          {/each}
          </ShSortableList>
        </div>
        {/key}
      {/if}
      </div>
    {/each}
    </ShSortableList>
    <div class="flex flex-col items-center gap-2 px-2">
      <BaseRoundedButton
        rounded={IconRounded}
        onClick={async () => {
          addCharacter({reseter}) 
        }}
      >
        <PlusIcon size={20} />
      </BaseRoundedButton>
    </div>
  </div>
</div>
{/if}

<div
  class="setting-area z-30 h-full max-xs:relative flex-col overflow-y-auto overflow-x-hidden bg-darkbg py-6 text-textcolor max-h-full"
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
    class="flex w-full justify-end text-textcolor"
    onclick={async () => {
      if($sideBarClosing){
        return
      }
      $sideBarClosing = true;
    }}
  >
    <!-- <button class="border-none bg-transparent p-0 text-textcolor"><X /></button> -->
  </button>
  {#if $leftBarCollapsed}
    <button
      class="hidden max-xs:flex absolute top-3 left-0 h-12 w-12 border-r border-b border-t border-darkborderc rounded-r-md bg-darkbg risu-interactive-border transition-colors items-center justify-center text-textcolor opacity-50 hover:opacity-90 z-20"
      aria-label="Expand sidebar"
      onclick={() => leftBarCollapsed.set(false)}
    >
      <ArrowRight />
    </button>
  {/if}
  {#if sideBarMode === 0}
    {#if $selectedCharID < 0 || $settingsOpen}
      <span class="block text-base font-semibold text-textcolor mt-2">{language.recentChatsTitle}</span>
      <div class="flex items-center justify-between gap-2 mt-2">
        <span class="text-sm text-textcolor2">{language.hideRecentChats}</span>
        <ShSwitch
          checked={!!DBState.db.nodeOnlyHideRecentChats}
          onCheckedChange={(v) => (DBState.db.nodeOnlyHideRecentChats = v)}
        />
      </div>
      {#if DBState.db.nodeOnlyHideRecentChats}
        <!-- list hidden by user preference -->
      {:else if recentChars.length === 0}
        <span class="block text-sm text-textcolor2 mt-2">{language.noRecentChatsDesc}</span>
      {:else}
        <div class="flex flex-col gap-1.5 mt-2">
          {#each recentChars.slice(0, recentVisible) as rc (rc.index)}
            <button
              type="button"
              class="group flex items-center gap-2.5 rounded-md border border-borderc/10 bg-darkbg p-2 text-left transition-colors risu-interactive-border-subtle risu-interactive-surface-strong"
              onclick={() => changeChar(rc.index, {reseter})}
            >
              <div class="shrink-0">
                <SidebarAvatar
                  src={rc.image ? getCharImage(rc.image, "plain") : ""}
                  size="36"
                  rounded={IconRounded}
                  name={rc.name}
                  chaId={DBState.db.characters[rc.index]?.chaId}
                />
              </div>
              <div class="flex-1 min-w-0">
                <div class="text-sm font-semibold text-textcolor leading-tight truncate">{rc.name || "Unnamed"}</div>
                <div class="text-xs text-textcolor2 leading-tight truncate">{makeAgoText(rc.lastInteraction)}</div>
              </div>
            </button>
          {/each}
          {#if recentVisible < recentChars.length}
            <button
              type="button"
              class="w-full rounded-md border border-borderc/10 bg-darkbg p-2 text-center text-sm text-textcolor2 transition-colors risu-interactive-border-subtle risu-interactive-surface-strong risu-interactive-foreground"
              onclick={() => recentVisible += 10}
            >
              {language.loadMore}
            </button>
          {/if}
        </div>
      {/if}
    {:else if DBState.db.characters[$selectedCharID]?.chaId === '§playground'}
      <SideChatList bind:chara={ DBState.db.characters[$selectedCharID]} />
    {:else}
      <nav class="sidebar-mode-switch" aria-label={language.sidebarView}>
        <IconButtonGroup size="sm" className="contents">
        <button
          type="button"
          class="sidebar-mode-button sidebar-mode-tab"
          class:active={!$botMakerMode && !devTool}
          aria-current={!$botMakerMode && !devTool ? "page" : undefined}
          onclick={() => {
            devTool = false
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
            devTool = false
            botMakerMode.set(true)
          }}
        >
          <User2Icon />
          <span>{language.character}</span>
        </button>
        </IconButtonGroup>
      </nav>
      {#if QuickSettings.open}
        <QuickSettingsGui />
      {:else if $botMakerMode || devTool}
        <CharConfigHeader
          {devTool}
          onDevToolChange={(active) => {
            devTool = active
            if(active) botMakerMode.set(true)
          }}
        />
        {#if devTool}
          <h2 class="mb-2 mt-2 text-2xl font-bold">{language.devTools}</h2>
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
    color: var(--risu-theme-textcolor2);
    font-size: 0.8rem;
    font-weight: 500;
    line-height: 1;
    white-space: nowrap;
    transition: color 150ms ease;
  }

  .sidebar-mode-button:is(:hover, :focus-visible):not(.active) {
    color: var(--risu-theme-textcolor);
  }

  .sidebar-mode-button.active {
    color: var(--risu-theme-textcolor);
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

  .editMode {
    min-width: 6rem;
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

  .sidebar-layout-slot.sidebar-edit-mode {
    --sidebar-rail-size: 6rem;
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
  .hamburger-menu {
    top: calc(100% - var(--sidebar-control-scroll-gap));
    border-radius: 0 0 0.375rem 0.375rem;
    scrollbar-width: none;
    overscroll-behavior: none;
  }
  .sidebar-controls {
    --sidebar-control-edge-gap: 0.5rem;
    --sidebar-control-button-gap: 0.5rem;
    --sidebar-control-scroll-gap: 1rem;
    position: relative;
    display: flex;
    width: 100%;
    flex-direction: column;
    align-items: center;
    padding: var(--sidebar-control-edge-gap) 0 var(--sidebar-control-scroll-gap);
  }
  .sidebar-menu-bottom .sidebar-controls {
    order: 9999;
    padding: var(--sidebar-control-scroll-gap) 0 var(--sidebar-control-edge-gap);
  }
  :global(.sidebar-control-buttons) {
    gap: var(--sidebar-control-button-gap);
  }
  .sidebar-menu-bottom :global(.sidebar-control-buttons) {
    flex-direction: column-reverse;
  }
  .sidebar-menu-bottom .hamburger-menu {
    top: auto;
    bottom: calc(100% - var(--sidebar-control-scroll-gap));
    border-radius: 0.375rem 0.375rem 0 0;
  }
  .rs-sidebar:not(.sidebar-menu-bottom) :global(.sidebar-character-root) {
    padding-top: 0;
  }
  .hamburger-menu::-webkit-scrollbar {
    display: none;
  }
  .character-list {
    scrollbar-width: none;
  }
  .character-list::-webkit-scrollbar {
    display: none;
  }

</style>
