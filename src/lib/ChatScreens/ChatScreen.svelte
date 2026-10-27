<script lang="ts">
    import { getCustomBackground } from "../../ts/util";

    import { DBState } from 'src/ts/stores.svelte';
    import { openModuleListStore } from "../../ts/stores.svelte";
    import DefaultChatScreen from "./DefaultChatScreen.svelte";
    import defaultWallpaper from '../../etc/bg.jpg'
    import ChatList from "../Others/ChatList.svelte";
    import BackgroundDom from "./BackgroundDom.svelte";
    import SidebarArrow from "../UI/components/SidebarArrow.svelte";
    import ModuleChatMenu from "../Setting/Pages/Module/ModuleChatMenu.svelte";
    import { DEFAULT_TEXT_BORDER_COLOR, DEFAULT_TEXT_SCREEN_COLOR, getTextOutlineStyle } from 'src/ts/gui/textOutline';
    import { supportsCustomChatBackdrop } from 'src/ts/storage/database.svelte';
    let openChatList = $state(false)
    let openModuleList = $state(false)
    let localPortalTarget: HTMLDivElement | null = $state(null)

    $effect(() => {
        if ($openModuleListStore) {
            openModuleList = true
            openModuleListStore.set(false)
        }
    })

    const wallPaper = `background: url(${defaultWallpaper})`
    const textOutlineStyle = $derived(DBState.db.textBorder
        ? getTextOutlineStyle(DBState.db.textBorderColor ?? DEFAULT_TEXT_BORDER_COLOR)
        : '')
    const externalStyles = $derived(
            `background: ${(DBState.db.textScreenColor ?? DEFAULT_TEXT_SCREEN_COLOR)}80;\n`
        +   textOutlineStyle)
    const usesCustomChatBackdrop = $derived(supportsCustomChatBackdrop(DBState.db.theme))
    let bgImg= $state('')
    let lastBg = $state('')
    const defaultLayoutBackground = $derived(usesCustomChatBackdrop ? bgImg : '')
    const defaultLayoutStyle = $derived(usesCustomChatBackdrop ? externalStyles : textOutlineStyle)
    $effect.pre(() => {
        if(!usesCustomChatBackdrop){
            bgImg = ''
            lastBg = ''
            return
        }
        (async () =>{
            if(DBState.db.customBackground !== lastBg){
                lastBg = DBState.db.customBackground
                bgImg = await getCustomBackground(DBState.db.customBackground)
            }
        })()
    });
</script>

{#if DBState.db.theme === 'waifu'}
    <div bind:this={localPortalTarget} class="risu-local-stack grow h-full flex justify-center relative" style="{bgImg.length < 4 ? wallPaper : bgImg}">
        <SidebarArrow />
        <BackgroundDom />
        <div class="h-full w-2xl" style:width="{42 * (DBState.db.waifuWidth / 100)}rem">
            <DefaultChatScreen portalTarget={localPortalTarget} customStyle={`${externalStyles}backdrop-filter: blur(4px);`} bind:openChatList bind:openModuleList/>
        </div>
    </div>
{:else}
    <div bind:this={localPortalTarget} class="risu-local-stack grow h-full min-w-0 relative justify-center flex">
        <SidebarArrow />
        <BackgroundDom />
        <div style={defaultLayoutBackground} class="h-full w-full" class:max-w-6xl={DBState.db.classicMaxWidth}>
            <DefaultChatScreen portalTarget={localPortalTarget} customStyle={defaultLayoutStyle} bind:openChatList bind:openModuleList/>
        </div>
    </div>
{/if}
{#if openChatList}
    <ChatList bind:open={openChatList}/>
{:else if openModuleList}
    <ModuleChatMenu bind:open={openModuleList}/>
{/if}
