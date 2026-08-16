<script lang="ts">
    import { downloadRisuHub, getRisuHub, hubAdditionalHTML, type hubType } from "src/ts/characterCards";
    import { ArrowLeft, ArrowRight, MenuIcon, SearchIcon, XIcon } from "@lucide/svelte";
    import { alertInput } from "src/ts/alert";
    import { language } from "src/lang";
    import RisuHubIcon from "./RealmHubIcon.svelte";
    import { MobileGUI, RealmInitialOpenChar } from "src/ts/stores.svelte";
    import RealmPopUp from "./RealmPopUp.svelte";
    import IconButton from "../GUI/IconButton.svelte";
    import ShButton from "../GUI/ShButton.svelte";
    import ShInput from "../GUI/ShInput.svelte";
    import Portal from "../GUI/Portal.svelte";

    let openedData:null|hubType = $state(null)

    let charas:hubType[] = $state([])

    let page = $state(0)
    let sort = $state('recommended')

    let search = $state('')
    let menuOpen = $state(false)
    let nsfw = $state(false)

    async function getHub(){
        charas = await getRisuHub({
            search: search,
            page: page,
            nsfw: nsfw,
            sort: sort
        })
    }

    function changeSort(type:string) {
        if(sort === type){
            sort = 'recommended'
        }else{
            sort = type
        }
        page = 0
        return getHub()
    }

    function submitSearch() {
        if(sort === 'random' || sort === 'recommended'){
            sort = ''
        }
        page = 0
        getHub()
    }

    getHub()



    $effect(() => {
        if($RealmInitialOpenChar){
            openedData = $RealmInitialOpenChar
            $RealmInitialOpenChar = null
        }
    })
</script>
<div class="w-full flex justify-center mt-4 mb-2">
    <div class="mx-2 ml-4 flex w-2xl max-w-full items-stretch gap-2">
        <ShInput bind:value={search} className="h-11 min-h-11 grow text-xl" />
        <ShButton
            variant="outline"
            size="icon-lg"
            onclick={submitSearch}
            aria-label={language.search}
        >
            <SearchIcon />
        </ShButton>
        <ShButton
            variant="outline"
            size="icon-lg"
            onclick={() => { menuOpen = true }}
            aria-label="Menu"
        >
            <MenuIcon />
        </ShButton>
    </div>
</div>
{#if $MobileGUI}
<div class="ml-4 flex items-start ">
    <div class="p-2 flex mb-3 overflow-x-auto rounded-lg border-darkborderc border gap-2">
        <ShButton size="sm" variant={nsfw ? 'primary' : 'outline'} className={nsfw ? '' : 'text-textcolor2'} aria-pressed={nsfw} onclick={() => {
            nsfw = !nsfw
            getHub()
        }}>
            {nsfw ? 'NSFW' : 'SFW'}
        </ShButton>
        <div class="h-full border-r border-r-selected"></div>
        <ShButton variant="ghost" size="sm" onclick={() => {
            switch(sort){
                case '':
                    sort = 'trending'
                    break
                case 'trending':
                    sort = 'downloads'
                    break
                case 'downloads':
                    sort = 'random'
                    break
                default:
                    sort = ''
                    break
            }
            getHub()
        }}>
            {
                sort === 'recommended' ? language.recommended :
                sort === '' ? language.recent : 
                sort === 'trending' ? language.trending :
                sort === 'downloads' ? language.downloads :
                language.random
            }
        </ShButton>
    </div>
</div>
{:else}
    <div class="mb-3 flex w-full gap-2 overflow-x-auto p-1 sm:justify-center">
        <ShButton variant={nsfw ? 'primary' : 'outline'} className={nsfw ? '' : 'text-textcolor2'} aria-pressed={nsfw} onclick={() => {
            nsfw = !nsfw
            getHub()
        }}>
            NSFW
        </ShButton>
        <div class="mx-2 h-full border-r border-r-selected"></div>
        <ShButton variant={sort === '' ? 'primary' : 'outline'} className={sort === '' ? '' : 'text-textcolor2'} aria-pressed={sort === ''} onclick={() => {
            changeSort('')
        }}>
            {language.recent}
        </ShButton>
        <ShButton variant={sort === 'trending' ? 'primary' : 'outline'} className={sort === 'trending' ? '' : 'text-textcolor2'} aria-pressed={sort === 'trending'} onclick={() => {
            changeSort('trending')
        }}>
            {language.trending}
        </ShButton>
        <ShButton variant={sort === 'downloads' ? 'primary' : 'outline'} className={sort === 'downloads' ? '' : 'text-textcolor2'} aria-pressed={sort === 'downloads'} onclick={() => {
            changeSort('downloads')
        }}>
            {language.downloads}
        </ShButton>
        <ShButton variant={sort === 'random' ? 'primary' : 'outline'} className="min-w-0 max-w-full {sort === 'random' ? '' : 'text-textcolor2'}" aria-pressed={sort === 'random'} onclick={() => {
            changeSort('random')
        }}>
            {language.random}
        </ShButton>
    </div>
{/if}
{@html hubAdditionalHTML}
<div class="w-full flex gap-4 p-2 flex-wrap justify-center">
    {#key charas}
        {#each charas as chara}
            <RisuHubIcon onClick={() =>{openedData = chara}} chara={chara} />
        {/each}
    {/key}
</div>
{#if sort !== 'random' && sort !== 'recommended'}
    <div class="w-full flex justify-center">
        <div class="flex gap-2">
            <ShButton variant="secondary" size="icon-lg" className="size-14" disabled={page === 0} onclick={() => {
                page -= 1
                getHub()
            }}>
                <ArrowLeft />
            </ShButton>
            <div class="flex size-14 shrink-0 items-center justify-center rounded-md border border-darkborderc bg-darkbg">
                <span>{page + 1}</span>
            </div>
            <ShButton variant="secondary" size="icon-lg" className="size-14" onclick={() => {
                page += 1
                getHub()
            }}>
                <ArrowRight />
            </ShButton>
        </div>
    </div>
{/if}

{#if openedData}
    <RealmPopUp bind:openedData={openedData} />
{/if}


{#if menuOpen}
    <Portal>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="risu-modal-backdrop z-50 flex justify-center items-center" role="button" tabindex="0" onclick={() => {
        menuOpen = false
    }}>
        <div class="max-w-full bg-darkbg rounded-md flex flex-col gap-4 overflow-y-auto p-4">
            <h1 class="font-bold text-2xl w-full">
                <span>
                    Menu
                </span>
                <IconButton className="float-right" size="xl" aria-label="Close menu" onclick={() => {menuOpen = false}}>
                    <XIcon />
                </IconButton>
            </h1>
            <div class=" mt-2 w-full border-t-2 border-t-bgcolor"></div>
            <ShButton variant="ghost" className="h-auto w-full p-4" onclick={(async (e) => {
                e.stopPropagation()
                menuOpen = false
                const input = await alertInput('Input URL or ID')
                if(input.startsWith("http")){
                    const url = new URL(input)
                    const id = url.searchParams.get("realm") ?? url.searchParams.get("code") ?? input.split("/").at(-1)
                    if(id){
                        downloadRisuHub(id)
                        return
                    }
                }
                const id = input.split("?").at(-1)
                downloadRisuHub(id)

            })}>Import Character from URL or ID</ShButton>
        </div>
    </div>
    </Portal>
{/if}
