<script lang="ts">
    import { language } from "src/lang";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import { forageStorage } from "src/ts/globalApi.svelte";
    import { getSyncClientId } from "src/ts/storage/nodeStorage";
    import { alertConfirm } from "src/ts/alert";
    import { isSecureContext } from "src/ts/secureContext";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import ShInput from "src/lib/UI/GUI/ShInput.svelte";
    import ShAlert from "src/lib/UI/GUI/ShAlert.svelte";
    import { LoaderCircleIcon, CopyIcon, CheckIcon, DownloadIcon, TriangleAlertIcon, InfoIcon, MonitorIcon, SmartphoneIcon } from "@lucide/svelte";
    import QRCode from "qrcode";
    import SettingLayout from "src/lib/Setting/Wrappers/SettingLayout.svelte";

    type ActiveDevice = {
        id: string;
        device: { name: string; type: 'desktop' | 'mobile' };
        connectedAt: number;
        current: boolean;
    };

    let status = $state<'loading' | 'disabled' | 'off' | 'downloading' | 'starting' | 'running' | 'error'>('loading');
    let tunnelUrl = $state<string | null>(null);
    let tunnelError = $state<string | null>(null);
    let qrDataUrl = $state<string | null>(null);
    let copied = $state(false);
    let platform = $state<string | null>(null);
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let devicePollTimer: ReturnType<typeof setInterval> | null = null;
    let activeDevices = $state<ActiveDevice[]>([]);
    let devicesLoading = $state(true);

    async function authHeaders() {
        const auth = await forageStorage.createAuth();
        return {
            'risu-auth': auth,
            'x-sync-client-id': getSyncClientId(),
        };
    }

    async function fetchStatus() {
        try {
            const res = await fetch('/api/tunnel/status', { headers: await authHeaders() });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            platform = data.platform ?? null;
            if (data.disabled) {
                status = 'disabled';
            } else {
                status = data.status;
                tunnelUrl = data.url;
                tunnelError = data.error;

                if (data.status === 'running' && data.url) {
                    qrDataUrl = await QRCode.toDataURL(data.url, { width: 200, margin: 2 });
                }

                if ((data.status === 'starting' || data.status === 'downloading') && !pollTimer) {
                    pollTimer = setInterval(fetchStatus, 2000);
                } else if (data.status !== 'starting' && data.status !== 'downloading' && pollTimer) {
                    clearInterval(pollTimer);
                    pollTimer = null;
                }
            }
        } catch {
            if (status === 'loading') status = 'error';
            tunnelError = 'Failed to connect to server';
            if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        }
    }

    async function fetchActiveDevices() {
        try {
            const res = await fetch('/api/active-devices', { headers: await authHeaders() });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            activeDevices = (await res.json()).devices ?? [];
        } catch {
            activeDevices = [];
        } finally {
            devicesLoading = false;
        }
    }

    function lastSeenText(timestamp: number) {
        const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
        return language.sessionLastSeen(seconds);
    }

    async function startTunnel() {
        status = 'starting';
        tunnelError = null;
        try {
            const res = await fetch('/api/tunnel/start', {
                method: 'POST',
                headers: await authHeaders(),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({ error: 'Unknown error' }));
                throw new Error(data.error);
            }
            const data = await res.json();
            if (data.status === 'downloading') status = 'downloading';
            if (pollTimer) clearInterval(pollTimer);
            pollTimer = setInterval(fetchStatus, 2000);
        } catch (e: any) {
            status = 'error';
            tunnelError = e.message;
        }
    }

    async function stopTunnel() {
        if (!await alertConfirm(language.remoteAccessCloseConfirm)) return;
        try {
            await fetch('/api/tunnel/stop', {
                method: 'POST',
                headers: await authHeaders(),
            });
        } catch {}
        status = 'off';
        tunnelUrl = null;
        qrDataUrl = null;
        tunnelError = null;
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    async function copyUrl() {
        if (!tunnelUrl) return;
        try {
            await navigator.clipboard.writeText(tunnelUrl);
            copied = true;
            setTimeout(() => { copied = false; }, 2000);
        } catch {}
    }

    $effect(() => {
        fetchStatus();
        fetchActiveDevices();
        devicePollTimer = setInterval(fetchActiveDevices, 5000);
        return () => {
            if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
            if (devicePollTimer) { clearInterval(devicePollTimer); devicePollTimer = null; }
        };
    });
</script>

<SettingPage title={language.connectionManagement}>
<SettingLayout variant="panel">
    <div class="flex items-center gap-2 text-textcolor mb-3">
        <MonitorIcon size={16} />
        <span class="font-medium">{language.deviceList}</span>
    </div>

    {#if devicesLoading}
        <div class="flex items-center justify-center py-6 text-textcolor2">
            <LoaderCircleIcon class="animate-spin" size={20} />
        </div>
    {:else if activeDevices.length === 0}
        <p class="text-textcolor2 text-sm py-2">{language.deviceListEmpty}</p>
    {:else}
        <div class="flex flex-col divide-y divide-darkborderc/60 border border-darkborderc rounded-md overflow-hidden">
            {#each activeDevices as session (session.id)}
                <div class="flex items-center gap-3 px-4 py-3 bg-bgcolor/30">
                    <div class="text-textcolor shrink-0">
                        {#if session.device.type === 'mobile'}
                            <SmartphoneIcon size={20} />
                        {:else}
                            <MonitorIcon size={20} />
                        {/if}
                    </div>
                    <div class="flex flex-1 items-center gap-2 min-w-0">
                        <span class="text-textcolor truncate">
                            {session.device.name === 'Unknown device' ? language.sessionUnknownDevice : session.device.name}
                        </span>
                        {#if session.current}
                            <span class="text-xs text-textcolor2 bg-darkbg border border-darkborderc rounded px-1.5 py-0.5 shrink-0">
                                {language.sessionCurrentDevice}
                            </span>
                        {/if}
                    </div>
                    <span class="text-textcolor2 text-sm text-center shrink-0 w-20 sm:w-28">
                        {lastSeenText(session.connectedAt)}
                    </span>
                </div>
            {/each}
        </div>
    {/if}
</SettingLayout>

<SettingLayout variant="panel">
    <div class="flex items-center gap-2 text-textcolor mb-3">
        <SmartphoneIcon size={16} />
        <span class="font-medium">{language.remoteAccess}</span>
    </div>
    <p class="text-textcolor2 text-sm leading-relaxed mb-3">{language.remoteAccessDesc}</p>

    {#if platform === 'android'}
        <ShAlert variant="destructive">
            {#snippet icon()}<TriangleAlertIcon />{/snippet}
            {language.remoteAccessTermuxWarning}
        </ShAlert>

    {:else if status === 'loading'}
        <div class="flex items-center justify-center py-8 text-textcolor2">
            <LoaderCircleIcon class="animate-spin" size={28} />
        </div>

    {:else if status === 'disabled'}
        <div class="text-sm text-yellow-400">{language.remoteAccessDisabled}</div>

    {:else if status === 'off'}
        <div class="flex justify-end">
            <ShButton variant="outline" onclick={startTunnel}>
                <SmartphoneIcon />
                {language.remoteAccessOpen}
            </ShButton>
        </div>

    {:else if status === 'downloading'}
        <div class="flex items-center gap-3 py-2 text-textcolor2">
            <DownloadIcon class="animate-pulse" size={20} />
            <span>{language.remoteAccessDownloading}</span>
        </div>

    {:else if status === 'starting'}
        <div class="flex items-center gap-3 py-2 text-textcolor2">
            <LoaderCircleIcon class="animate-spin" size={20} />
            <span>{language.remoteAccessStarting}</span>
        </div>

    {:else if status === 'running' && tunnelUrl}
        <div class="flex flex-col items-center gap-4 rounded-md p-4 border border-darkborderc/60">
            {#if qrDataUrl}
                <img src={qrDataUrl} alt="QR Code" class="rounded-lg" width="200" height="200" />
                <p class="text-sm text-textcolor2">{language.remoteAccessQrHint}</p>
            {/if}

            <div class="flex items-center gap-2 w-full max-w-md">
                <ShInput
                    type="text"
                    readonly
                    value={tunnelUrl ?? ''}
                    className="flex-1 select-all"
                />
                {#if isSecureContext}
                <ShButton variant="outline" size="icon" onclick={copyUrl} aria-label={language.remoteAccessCopyUrl}>
                    {#if copied}
                        <CheckIcon />
                    {:else}
                        <CopyIcon />
                    {/if}
                </ShButton>
                {/if}
            </div>

            <ShAlert variant="destructive" className="w-full max-w-md">
                {#snippet icon()}<TriangleAlertIcon />{/snippet}
                {language.remoteAccessWarning}
            </ShAlert>

            <ShAlert variant="info" className="w-full max-w-md">
                {#snippet icon()}<InfoIcon />{/snippet}
                {language.remoteAccessInfo}
            </ShAlert>

            <ShButton variant="destructive" onclick={stopTunnel} className="mt-2">{language.remoteAccessClose}</ShButton>
        </div>

    {:else if status === 'error'}
        <div class="flex flex-col gap-2">
            <div class="text-sm text-red-400">
                {language.remoteAccessError}{tunnelError ? `: ${tunnelError}` : ''}
            </div>
            <ShButton variant="outline" size="sm" onclick={startTunnel} className="mt-1 self-start">{language.remoteAccessRetry}</ShButton>
        </div>
    {/if}
</SettingLayout>
</SettingPage>
