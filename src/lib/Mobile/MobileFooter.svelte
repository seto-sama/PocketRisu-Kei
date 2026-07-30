<script lang="ts">

  import { SettingsIcon, GlobeIcon, HouseIcon, Volume2Icon, Braces, ActivityIcon, BookIcon, SmileIcon, UserIcon } from "@lucide/svelte";
  import { language } from "src/lang";
  import { CharConfigSubMenu, DBState, MobileGUIStack, MobileSideBar, selectedCharID } from "src/ts/stores.svelte";
  import IconButtonGroup from "src/lib/UI/GUI/IconButtonGroup.svelte";

</script>
{#if $selectedCharID === -1}

    <IconButtonGroup size="sm" className="w-full p-4 text-lg border-t border-t-darkborderc bg-darkbg justify-center text-textcolor2">
        <button class="flex justify-center items-center flex-col gap-2 w-20" class:text-textcolor={$MobileGUIStack === 0} onclick={() => {
            MobileGUIStack.set(0)
        }}>
            <GlobeIcon />
            <span class="text-xs">RisuRealm</span>
        </button>
        <button class="flex justify-center items-center flex-col gap-2 w-20" class:text-textcolor={$MobileGUIStack === 1} onclick={() => {
            MobileGUIStack.set(1)
        }}>
            <HouseIcon />
            <span class="text-xs">{language.character}</span>
        </button>
        <button class="flex justify-center items-center flex-col gap-2 w-20" class:text-textcolor={$MobileGUIStack === 2} onclick={() => {
            MobileGUIStack.set(2)
        }}>
            <SettingsIcon />
            <span class="text-xs">{language.settings}</span>
        </button>
    </IconButtonGroup>

{/if}

{#if $selectedCharID !== -1 && $MobileSideBar === 2}
    <IconButtonGroup size="sm" className="w-full p-4 text-lg border-t border-t-darkborderc bg-darkbg justify-center text-textcolor2 truncate">
        <button class="flex justify-center items-center flex-col gap-2 w-16 max-w-16" class:text-textcolor={$CharConfigSubMenu === 0} onclick={() => {
            CharConfigSubMenu.set(0)
        }}>
            <UserIcon />
            <span class="text-xs truncate max-w-16">{language.basicInfo}</span>
        </button>
        <button class="flex justify-center items-center flex-col gap-2 w-16 max-w-16" class:text-textcolor={$CharConfigSubMenu === 1} onclick={() => {
            CharConfigSubMenu.set(1)
        }}>
            <SmileIcon />
            <span class="text-xs truncate max-w-16">{language.characterDisplay}</span>
        </button>
        <button class="flex justify-center items-center flex-col gap-2 w-16 max-w-16" class:text-textcolor={$CharConfigSubMenu === 3} onclick={() => {
            CharConfigSubMenu.set(3)
        }}>
            <BookIcon />
            <span class="text-xs truncate max-w-16">{language.loreBook}</span>
        </button>
        {#if DBState.db.ttsEnabled}
            <button class="flex justify-center items-center flex-col gap-2 w-16 max-w-16" class:text-textcolor={$CharConfigSubMenu === 5} onclick={() => {
                CharConfigSubMenu.set(5)
            }}>
                <Volume2Icon />
                <span class="text-xs truncate max-w-16">TTS</span>
            </button>
        {/if}
        <button class="flex justify-center items-center flex-col gap-2 w-16 max-w-16" class:text-textcolor={$CharConfigSubMenu === 4} onclick={() => {
            CharConfigSubMenu.set(4)
        }}>
            <Braces />
            <span class="text-xs truncate max-w-16">{language.scripts}</span>
        </button>
        <button class="flex justify-center items-center flex-col gap-2 w-16 max-w-16" class:text-textcolor={$CharConfigSubMenu === 2} onclick={() => {
            CharConfigSubMenu.set(2)
        }}>
            <ActivityIcon />
            <span class="text-xs truncate max-w-16">{language.advanced}</span>
        </button>
    </IconButtonGroup>
{/if}
