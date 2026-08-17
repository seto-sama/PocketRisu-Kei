<script lang="ts">
    import { downloadRisuHub, getRisuHub, hubAdditionalHTML, type hubType } from "src/ts/characterCards";
    import { ChevronLeft, ChevronRight, SearchIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import RisuHubIcon from "./RealmHubIcon.svelte";
    import { MobileGUI } from "src/ts/stores.svelte";
    import RealmPopUp from "./RealmPopUp.svelte";
    import ShButton from "../GUI/ShButton.svelte";
    import ShInput from "../GUI/ShInput.svelte";
    import IconButton from "../GUI/IconButton.svelte";
    import IconButtonGroup from "../GUI/IconButtonGroup.svelte";

    let openedData:null|hubType = $state(null)

    let charas:hubType[] = $state([])

    let page = $state(0)
    let sort = $state('recommended')

    let search = $state('')
    let nsfw = $state(false)

    const compactFilterButton = 'max-md:h-8 max-md:px-2.5 max-md:text-sm max-md:gap-1 max-md:[&_svg]:size-4'

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

    function getRealmUrlImportId(input: string): string | null {
        const value = input.trim()
        if (!value) return null

        try {
            const normalized = /^(?:www\.)?realm\.risuai\.net(?:[/?#]|$)/i.test(value)
                ? `https://${value}`
                : value
            const url = new URL(normalized)
            if (url.hostname !== 'realm.risuai.net' && url.hostname !== 'www.realm.risuai.net') {
                return null
            }
            const queryId = url.searchParams.get('realm') ?? url.searchParams.get('code')
            const pathId = url.pathname.split('/').filter(Boolean).at(-1)
            return queryId || pathId || null
        } catch {
            return null
        }
    }

    async function submitSearch() {
        const realmId = getRealmUrlImportId(search)
        if (realmId) {
            await downloadRisuHub(realmId)
            return
        }
        if(sort === 'random' || sort === 'recommended'){
            sort = ''
        }
        page = 0
        getHub()
    }

    getHub()
</script>
<div class="mx-auto w-full max-w-4xl">
    <div class="mb-2 mt-4 flex w-full items-stretch gap-2 px-2">
        <ShInput
            bind:value={search}
            className="h-11 min-h-11 grow text-xl"
            onkeydown={(event) => {
                if (event.key === 'Enter') {
                    event.preventDefault()
                    submitSearch()
                }
            }}
        />
        <ShButton
            variant="outline"
            size="icon-lg"
            onclick={submitSearch}
            aria-label={language.search}
        >
            <SearchIcon />
        </ShButton>
    </div>
    {#if $MobileGUI}
        <div class="flex items-start px-2">
            <div class="mb-3 flex gap-2 overflow-x-auto rounded-lg border border-darkborderc p-2">
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
            <ShButton variant={nsfw ? 'primary' : 'outline'} className={`${compactFilterButton} ${nsfw ? '' : 'text-textcolor2'}`} aria-pressed={nsfw} onclick={() => {
                nsfw = !nsfw
                getHub()
            }}>
                NSFW
            </ShButton>
            <div class="mx-2 h-full border-r border-r-selected"></div>
            <ShButton variant={sort === '' ? 'primary' : 'outline'} className={`${compactFilterButton} ${sort === '' ? '' : 'text-textcolor2'}`} aria-pressed={sort === ''} onclick={() => {
                changeSort('')
            }}>
                {language.recent}
            </ShButton>
            <ShButton variant={sort === 'trending' ? 'primary' : 'outline'} className={`${compactFilterButton} ${sort === 'trending' ? '' : 'text-textcolor2'}`} aria-pressed={sort === 'trending'} onclick={() => {
                changeSort('trending')
            }}>
                {language.trending}
            </ShButton>
            <ShButton variant={sort === 'downloads' ? 'primary' : 'outline'} className={`${compactFilterButton} ${sort === 'downloads' ? '' : 'text-textcolor2'}`} aria-pressed={sort === 'downloads'} onclick={() => {
                changeSort('downloads')
            }}>
                {language.downloads}
            </ShButton>
            <ShButton variant={sort === 'random' ? 'primary' : 'outline'} className={`${compactFilterButton} min-w-0 max-w-full ${sort === 'random' ? '' : 'text-textcolor2'}`} aria-pressed={sort === 'random'} onclick={() => {
                changeSort('random')
            }}>
                {language.random}
            </ShButton>
        </div>
    {/if}
    {@html hubAdditionalHTML}
    <div class="grid w-full grid-cols-1 gap-4 p-2 lg:grid-cols-2">
        {#each charas as chara (chara.id)}
            <RisuHubIcon onClick={() =>{openedData = chara}} chara={chara} />
        {/each}
    </div>
    {#if sort !== 'random' && sort !== 'recommended'}
        <div class="flex w-full justify-center py-3">
            <IconButtonGroup size="default" className="gap-0.5 [&_[data-icon-button]]:rounded-sm [&_[data-icon-button]]:risu-interactive-surface">
                <IconButton disabled={page === 0} onclick={() => {
                    page -= 1
                    getHub()
                }} aria-label="Previous page" className="text-textcolor">
                    <ChevronLeft />
                </IconButton>
                <span class="min-w-6 text-center text-xs tabular-nums text-textcolor">{page + 1}</span>
                <IconButton onclick={() => {
                    page += 1
                    getHub()
                }} aria-label="Next page" className="text-textcolor">
                    <ChevronRight />
                </IconButton>
            </IconButtonGroup>
        </div>
    {/if}
</div>

{#if openedData}
    <RealmPopUp bind:openedData={openedData} />
{/if}
