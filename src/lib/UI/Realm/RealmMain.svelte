<script lang="ts">
    import { downloadRisuHub, getRisuHub, hubAdditionalHTML, realmURL, type hubType } from "src/ts/characterCards";
    import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, MenuIcon, SearchIcon } from "@lucide/svelte";
    import { onDestroy } from "svelte";
    import { language } from "src/lang";
    import RisuHubIcon from "./RealmHubIcon.svelte";
    import RealmPopUp from "./RealmPopUp.svelte";
    import Button from "../components/Button.svelte";
    import Input from "../components/Input.svelte";
    import IconButton from "../components/IconButton.svelte";
    import IconButtonGroup from "../components/IconButtonGroup.svelte";
    import Dialog from "../components/Dialog.svelte";
    import * as DropdownMenu from "../components/dropdown-menu";
    import { filterMutedRealmCharacters, realmMuteStore } from "src/ts/realmMute";
    import RealmMuteManager from "./RealmMuteManager.svelte";

    interface Props {
        onClose?: () => void;
    }

    let { onClose }: Props = $props();

    let openedData:null|hubType = $state(null)
    let charas:hubType[] = $state([])
    let page = $state(0)
    let sort = $state('')
    let search = $state('')
    let nsfw = $state(false)
    let open = $state(true)
    let importingUrl = $state(false)
    let muteManagerOpen = $state(false)
    let hubRequest: AbortController | null = null
    let hubRequestId = 0
    const realmHostname = new URL(realmURL).hostname
    const visibleCharas = $derived(filterMutedRealmCharacters(charas, $realmMuteStore))

    function closeRealm() {
        open = false
        openedData = null
        onClose?.()
    }

    async function getHub(){
        hubRequest?.abort()
        const request = new AbortController()
        const requestId = ++hubRequestId
        hubRequest = request
        const result = await getRisuHub({
            search: search,
            page: page,
            nsfw: nsfw,
            sort: sort,
            signal: request.signal,
        })
        if (requestId === hubRequestId) charas = result
    }

    function selectSort(type:string) {
        sort = type
        page = 0
        return getHub()
    }

    function toggleNsfw() {
        nsfw = !nsfw
        page = 0
        return getHub()
    }

    function getRealmUrlImportId(input: string): string | null {
        const value = input.trim()
        if (!value) return null

        try {
            const normalized = new RegExp(`^(?:www\\.)?${realmHostname.replaceAll('.', '\\.')}([/?#]|$)`, 'i').test(value)
                ? `https://${value}`
                : value
            const url = new URL(normalized)
            if (url.hostname !== realmHostname && url.hostname !== `www.${realmHostname}`) {
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
            if (importingUrl) return
            importingUrl = true
            try {
                if (await downloadRisuHub(realmId)) closeRealm()
            } finally {
                importingUrl = false
            }
            return
        }
        if(sort === 'random'){
            sort = ''
        }
        page = 0
        getHub()
    }

    onDestroy(() => {
        hubRequestId++
        hubRequest?.abort()
    })

    getHub()
</script>
<Dialog
    bind:open
    size="xl"
    closeOnEscape
    onRequestClose={closeRealm}
    contentClass="h-[calc(100dvh-1rem)] bg-lightbg sm:h-[calc(100dvh-2rem)]"
    bodyClass="flex min-h-0 flex-1 flex-col"
>
    {#snippet title()}
        <span class="block truncate">{language.getMoreCharacters}</span>
    {/snippet}

    <div class="mb-3 flex w-full items-stretch gap-2">
        <Input
            bind:value={search}
            className="h-11 min-h-11 grow text-xl"
            onkeydown={(event) => {
                if (event.key === 'Enter') {
                    event.preventDefault()
                    submitSearch()
                }
            }}
        />
        <Button
            disabled={importingUrl}
            variant="outline"
            size="icon-lg"
            onclick={submitSearch}
            aria-label={language.search}
        >
            <SearchIcon />
        </Button>
        <DropdownMenu.Root>
            <DropdownMenu.Trigger>
                {#snippet child({ props })}
                    <Button {...props} variant="outline" size="icon-lg" aria-label={language.menu} title={language.menu}>
                        <MenuIcon />
                    </Button>
                {/snippet}
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="end" class="min-w-44">
                <DropdownMenu.Item onSelect={() => { muteManagerOpen = true }}>
                    <span>{language.realmMuteManagement}</span>
                </DropdownMenu.Item>
                <DropdownMenu.Item onSelect={toggleNsfw}>
                    <span>NSFW {language.realmViewSuffix}</span>
                    {#if nsfw}<CheckIcon class="ml-auto text-primary" />{/if}
                </DropdownMenu.Item>
                <DropdownMenu.Item onSelect={() => selectSort('')}>
                    <span>{language.recent} {language.realmViewSuffix}</span>
                    {#if sort === ''}<CheckIcon class="ml-auto text-primary" />{/if}
                </DropdownMenu.Item>
                <DropdownMenu.Item onSelect={() => selectSort('trending')}>
                    <span>{language.trending} {language.realmViewSuffix}</span>
                    {#if sort === 'trending'}<CheckIcon class="ml-auto text-primary" />{/if}
                </DropdownMenu.Item>
                <DropdownMenu.Item onSelect={() => selectSort('downloads')}>
                    <span>{language.downloads} {language.realmViewSuffix}</span>
                    {#if sort === 'downloads'}<CheckIcon class="ml-auto text-primary" />{/if}
                </DropdownMenu.Item>
                <DropdownMenu.Item onSelect={() => selectSort('random')}>
                    <span>{language.random} {language.realmViewSuffix}</span>
                    {#if sort === 'random'}<CheckIcon class="ml-auto text-primary" />{/if}
                </DropdownMenu.Item>
            </DropdownMenu.Content>
        </DropdownMenu.Root>
    </div>

    <div class="realm-results min-h-0 flex-1 overflow-y-auto">
        {@html hubAdditionalHTML}
        <div class="grid w-full grid-cols-1 gap-4 py-2 lg:grid-cols-2">
            {#each visibleCharas as chara (chara.id)}
                <RisuHubIcon onClick={() => { openedData = chara }} chara={chara} />
            {/each}
        </div>
        {#if sort !== 'random'}
            <div class="flex w-full justify-center py-3">
                <IconButtonGroup size="default" className="gap-0.5 [&_[data-icon-button]]:rounded-sm [&_[data-icon-button]]:risu-interactive-surface">
                    <IconButton disabled={page === 0} onclick={() => {
                        page -= 1
                        getHub()
                    }} aria-label="Previous page" className="text-maintext">
                        <ChevronLeftIcon />
                    </IconButton>
                    <span class="min-w-6 text-center text-xs tabular-nums text-maintext">{page + 1}</span>
                    <IconButton onclick={() => {
                        page += 1
                        getHub()
                    }} aria-label="Next page" className="text-maintext">
                        <ChevronRightIcon />
                    </IconButton>
                </IconButtonGroup>
            </div>
        {/if}
    </div>
</Dialog>

{#if openedData}
    <RealmPopUp bind:openedData={openedData} onDownloaded={closeRealm} />
{/if}

{#if muteManagerOpen}
    <RealmMuteManager onClose={() => { muteManagerOpen = false }} />
{/if}

<style>
    .realm-results {
        scrollbar-width: none;
    }

    .realm-results::-webkit-scrollbar {
        display: none;
    }
</style>
