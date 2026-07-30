<script lang="ts">
    import { RefreshCwIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { syncRemoteRegistry } from "src/ts/preset/registry";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";

    let busy = $state(false);
    let status = $state("");

    async function refresh() {
        if (busy) return;
        busy = true;
        status = "";
        try {
            // force=true bypasses the cache interval and downloads models.dev
            // again. Echo and Plugin do not depend on this request.
            const res = await syncRemoteRegistry(true);
            if (!res.ok) {
                status = res.error ? `${language.registrySyncFailed}: ${res.error}` : language.registrySyncFailed;
            } else if (res.changed) {
                status = language.registrySyncUpdated;
            } else if (res.downloaded) {
                // Re-downloaded but the catalog content did not change.
                status = language.registryRefreshed;
            } else {
                status = language.registrySyncUpToDate;
            }
        } catch (e) {
            // syncRemoteRegistry shouldn't throw, but never leave the button stuck.
            status = `${language.registrySyncFailed}: ${(e as Error).message}`;
        } finally {
            busy = false;
        }
    }
</script>

<div class="flex items-center justify-between gap-3 py-3 border-t border-darkborderc">
    <div class="flex flex-col min-w-0">
        <span class="text-sm text-textcolor">{language.registryRefresh}</span>
        <p class="text-xs text-textcolor2 mt-0.5">{status || language.registryRefreshHelp}</p>
    </div>
    <ShButton variant="outline" size="sm" onclick={refresh} disabled={busy} className="shrink-0">
        <RefreshCwIcon class={busy ? "animate-spin" : ""} />
        <span class="ml-1">{busy ? language.registrySyncing : language.registryRefreshNow}</span>
    </ShButton>
</div>
