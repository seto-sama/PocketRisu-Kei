<script lang="ts">
    import { DBState } from 'src/ts/stores.svelte';
    import Hub from "./Realm/RealmMain.svelte";
    import { OpenRealmStore } from "src/ts/stores.svelte";
    import { ChevronDown, HomeIcon, SendIcon, TriangleAlertIcon, UsersIcon } from "@lucide/svelte";
    import GithubIcon from "./GithubIcon.svelte";
    import { getVersionString, openURL } from "src/ts/globalApi.svelte";
    import { language } from "src/lang";
    import { getRisuHub, hubAdditionalHTML, showRealmInfoStore } from "src/ts/characterCards";
    import RisuHubIcon from "./Realm/RealmHubIcon.svelte";
    import Title from "./Title.svelte";
    import { updateInfoStore, updatePopupStore } from "src/ts/update";
    import { publicStatsStore } from "src/ts/publicStats";
    import { isSecureContext } from "src/ts/secureContext";
    import { openSettings, SettingsRoute } from "src/ts/routing";
    import ShButton from "./GUI/ShButton.svelte";
    import ShAlert from "./GUI/ShAlert.svelte";
    import IconButton from "./GUI/IconButton.svelte";

    let realmOpen = $state(!DBState.db.hideRealm);

    const relatedLinkIconClass =
      "h-40 w-40 md:h-44 md:w-44 origin-right -rotate-12 opacity-[0.12] transition-all duration-500 group-hover:scale-105 group-hover:opacity-[0.22]";
</script>
<div class="h-full w-full flex flex-col overflow-y-auto items-center">
    {#if !$OpenRealmStore}
      <Title />
      <h3 class="text-textcolor2 mt-1">v{getVersionString()}</h3>
      {#if $updateInfoStore?.hasUpdate}
        <ShButton
          variant={$updateInfoStore.severity === 'optional' ? 'success' : 'destructive'}
          size="sm"
          className="mt-1.5 rounded-full"
          onclick={() => updatePopupStore.set($updateInfoStore)}
        >
          {#if $updateInfoStore.severity === 'outdated'}
            ⚠ {language.updateOutdated.replace('{{version}}', $updateInfoStore.latestVersion)}
          {:else if $updateInfoStore.severity === 'required'}
            ⚠ {language.updateRequired.replace('{{version}}', $updateInfoStore.latestVersion)}
          {:else}
            {language.updateAvailable.replace('{{version}}', $updateInfoStore.latestVersion)}
          {/if}
        </ShButton>
      {/if}
      {#if $publicStatsStore}
      <div class="mt-3 flex gap-2 flex-wrap justify-center">
        <span class="px-3 py-1 rounded-full text-xs bg-darkbg border border-selected text-textcolor2">
          👥 {language.statsUsersToday.replace('{{count}}', $publicStatsStore.dau.toLocaleString())}
          <span class="text-textcolor2/60">({language.statsYesterday.replace('{{count}}', $publicStatsStore.yesterdayDau.toLocaleString())})</span>
        </span>
        <span class="px-3 py-1 rounded-full text-xs bg-darkbg border border-selected text-textcolor2">
          📊 {language.statsVisitsToday.replace('{{count}}', $publicStatsStore.visits.toLocaleString())}
        </span>
      </div>
      {/if}
    {/if}
    <div class="w-full flex p-4 flex-col text-textcolor max-w-4xl">
      {#if !$OpenRealmStore}
      {#if !isSecureContext}
        <ShAlert variant="warning" className="mt-4 w-full">
          {#snippet icon()}<TriangleAlertIcon />{/snippet}
          {#snippet title()}{language.httpInsecureWarningTitle}{/snippet}
          {language.httpInsecureWarningBody}
          {#snippet action()}
            <ShButton variant="outline" size="sm" onclick={() => openSettings(SettingsRoute.RemoteAccess)}>
              {language.httpInsecureOpenRemoteAccess}
            </ShButton>
          {/snippet}
        </ShAlert>
      {/if}
      <div class="mt-4 mb-4 w-full border-t border-t-selected"></div>
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="flex-1 flex items-center gap-2 rounded border border-transparent text-2xl font-bold text-left transition-colors"
          aria-expanded={realmOpen}
          aria-controls="main-realm-section"
          onclick={() => (realmOpen = !realmOpen)}
        >
          <span>Recently Uploaded</span>
          <ChevronDown
            size={20}
            class="shrink-0 transition-transform duration-150 {realmOpen ? 'rotate-180' : ''}"
          />
        </button>
        <ShButton
          variant="ghost"
          size="sm"
          className="bg-darkbg"
          onclick={() => {
            $OpenRealmStore = true
          }}
        >Get More</ShButton>
      </div>
      <div
        id="main-realm-section"
        role="region"
        aria-hidden={!realmOpen}
        inert={!realmOpen}
      >
        {#if realmOpen}
          {#await getRisuHub({
                search: '',
                page: 0,
                nsfw: false,
                sort: 'recommended'
            }) then charas}
            {#if charas.length > 0}
              {@html hubAdditionalHTML}
              <div class="w-full flex gap-4 p-2 flex-wrap justify-center">
                  {#each charas as chara}
                      <RisuHubIcon onClick={() => {
                        $showRealmInfoStore = chara
                      }} chara={chara} />
                  {/each}
              </div>
            {:else}
              <div class="text-textcolor2">Failed to load {language.hub}...</div>
            {/if}
          {/await}
        {/if}
      </div>
      <div class="mt-4 mb-4 w-full border-t border-t-selected"></div>
      <h1 class="text-2xl font-bold mb-4">
        Related Links
      </h1>
        <div class="grid w-full grid-cols-1 gap-4 p-2 md:grid-cols-2">
          <button class="group relative flex min-h-35 flex-col justify-center overflow-hidden rounded-2xl border border-borderc/10 bg-darkbg p-6 text-left transition-all duration-300 hover:-translate-y-1 risu-interactive-border-subtle risu-interactive-surface-strong hover:shadow-xl hover:shadow-darkbg/50" onclick={() => {
            openURL("https://github.com/seto-sama/PocketRisu-Kei")
          }}>
            <div class="relative z-10 w-[68%] sm:w-[70%]">
              <h2 class="text-2xl font-bold tracking-tight text-textcolor">{language.relatedGithub}</h2>
              <span class="mt-2 block text-base leading-relaxed text-textcolor2">
                {language.relatedGithubDesc}
              </span>
            </div>
            <div aria-hidden="true" class="pointer-events-none absolute -right-12 top-1/2 -translate-y-1/2 text-textcolor">
              <GithubIcon class={relatedLinkIconClass} />
            </div>
          </button>
          <button class="group relative flex min-h-35 flex-col justify-center overflow-hidden rounded-2xl border border-borderc/10 bg-darkbg p-6 text-left transition-all duration-300 hover:-translate-y-1 risu-interactive-border-subtle risu-interactive-surface-strong hover:shadow-xl hover:shadow-darkbg/50" onclick={() => {
            openURL("https://github.com/seto-sama/PocketRisu-Kei/issues/new")
          }}>
            <div class="relative z-10 w-[68%] sm:w-[70%]">
              <h2 class="text-2xl font-bold tracking-tight text-textcolor">{language.relatedFeedbackForm}</h2>
              <span class="mt-2 block text-base leading-relaxed text-textcolor2">
                {language.relatedFeedbackFormDesc}
              </span>
            </div>
            <div aria-hidden="true" class="pointer-events-none absolute -right-12 top-1/2 -translate-y-1/2 text-textcolor">
              <SendIcon class={relatedLinkIconClass} strokeWidth={1} />
            </div>
          </button>
          <button class="group relative flex min-h-35 flex-col justify-center overflow-hidden rounded-2xl border border-borderc/10 bg-darkbg p-6 text-left transition-all duration-300 hover:-translate-y-1 risu-interactive-border-subtle risu-interactive-surface-strong hover:shadow-xl hover:shadow-darkbg/50" onclick={() => {
            openURL("https://github.com/seto-sama")
          }}>
            <div class="relative z-10 w-[68%] sm:w-[70%]">
              <h2 class="text-2xl font-bold tracking-tight text-textcolor">{language.relatedContactEmail}</h2>
              <span class="mt-2 block text-base leading-relaxed text-textcolor2">
                {language.relatedContactEmailDesc}
              </span>
            </div>
            <div aria-hidden="true" class="pointer-events-none absolute -right-12 top-1/2 -translate-y-1/2 text-textcolor">
              <GithubIcon class={relatedLinkIconClass} />
            </div>
          </button>
          <button class="group relative flex min-h-35 flex-col justify-center overflow-hidden rounded-2xl border border-borderc/10 bg-darkbg p-6 text-left transition-all duration-300 hover:-translate-y-1 risu-interactive-border-subtle risu-interactive-surface-strong hover:shadow-xl hover:shadow-darkbg/50" onclick={() => {
            openURL("https://arca.live/b/characterai")
          }}>
            <div class="relative z-10 w-[68%] sm:w-[70%]">
              <h2 class="text-2xl font-bold tracking-tight text-textcolor">{language.relatedArcaLive}</h2>
              <span class="mt-2 block text-base leading-relaxed text-textcolor2">
                {language.relatedArcaLiveDesc}
              </span>
            </div>
            <div aria-hidden="true" class="pointer-events-none absolute -right-12 top-1/2 -translate-y-1/2 text-textcolor">
              <UsersIcon class={relatedLinkIconClass} strokeWidth={1} />
            </div>
          </button>
        </div>

      {:else}
        <div class="mt-4 flex w-full items-center px-2">
          <IconButton size="xl" onclick={() => ($OpenRealmStore = false)} aria-label={language.home}>
            <HomeIcon/>
          </IconButton>
        </div>
        <Hub />
      {/if}
  </div>
</div>
