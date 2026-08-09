<script lang="ts">
    import { onMount } from 'svelte';
    import { PauseIcon, PlayIcon, Volume2Icon, VolumeXIcon } from '@lucide/svelte';

    interface Props {
        src: string;
        title?: string;
        characterName?: string;
        autoplay?: boolean;
        loop?: boolean;
    }

    let {
        src,
        title = 'Audio',
        characterName = '',
        autoplay = true,
        loop = true,
    }: Props = $props();

    let audioElement: HTMLAudioElement;
    let isPlaying = $state(false);
    let currentTime = $state(0);
    let duration = $state(0);
    let volume = $state(0.5);
    let previousVolume = 0.5;

    const progressPercent = $derived(duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0);
    const volumePercent = $derived(volume * 100);

    function formatTime(seconds: number): string {
        if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = Math.floor(seconds % 60);
        return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
    }

    async function togglePlayback() {
        if (audioElement.paused) {
            await audioElement.play().catch(() => {});
        } else {
            audioElement.pause();
        }
    }

    function seek(value: number) {
        if (!Number.isFinite(value)) return;
        audioElement.currentTime = value;
        currentTime = value;
    }

    function setVolume(value: number) {
        const nextVolume = Math.max(0, Math.min(1, value));
        audioElement.volume = nextVolume;
        volume = nextVolume;
        if (nextVolume > 0) previousVolume = nextVolume;
    }

    function toggleMute() {
        setVolume(volume > 0 ? 0 : previousVolume || 0.5);
    }

    onMount(() => {
        audioElement.volume = volume;
        if (autoplay) void audioElement.play().catch(() => {});

        return () => {
            audioElement.pause();
            audioElement.removeAttribute('src');
            audioElement.load();
        };
    });
</script>

<div class="w-full max-w-lg rounded-lg border border-darkborderc/50 bg-darkbg/50 p-2.5 text-textcolor shadow-lg backdrop-blur-sm">
    <audio
        class="hidden"
        bind:this={audioElement}
        {src}
        {loop}
        preload="metadata"
        onloadedmetadata={() => { duration = Number.isFinite(audioElement.duration) ? audioElement.duration : 0 }}
        ondurationchange={() => { duration = Number.isFinite(audioElement.duration) ? audioElement.duration : 0 }}
        ontimeupdate={() => { currentTime = audioElement.currentTime }}
        onplay={() => { isPlaying = true }}
        onpause={() => { isPlaying = false }}
        onended={() => { isPlaying = false }}
    ></audio>

    <div class="mb-1.5 flex min-w-0 items-baseline justify-between gap-3">
        <div class="truncate text-sm font-semibold text-textcolor" title={title}>{title}</div>
        {#if characterName}
            <div class="shrink-0 truncate text-[11px] text-textcolor2" title={characterName}>{characterName}</div>
        {/if}
    </div>

    <div class="flex min-w-0 items-center gap-2">
        <button
            type="button"
            class="flex size-7 shrink-0 items-center justify-center rounded-full border-0 bg-primary p-0 text-textcolor shadow-none transition-colors risu-interactive-primary"
            aria-label={isPlaying ? 'Pause' : 'Play'}
            title={isPlaying ? 'Pause' : 'Play'}
            onclick={togglePlayback}
        >
            {#if isPlaying}
                <PauseIcon size={14} fill="currentColor" strokeWidth={1.5}/>
            {:else}
                <PlayIcon class="ml-0.5" size={14} fill="currentColor" strokeWidth={1.5}/>
            {/if}
        </button>

        <input
            class="audio-player-range min-w-16 flex-1"
            style={`--audio-range-fill: ${progressPercent}%`}
            type="range"
            min="0"
            max={duration || 0}
            step="0.1"
            value={currentTime}
            aria-label="Playback position"
            oninput={(event) => seek(Number(event.currentTarget.value))}
        />

        <div class="flex shrink-0 items-center text-[10px] tabular-nums">
            <span class="text-textcolor">{formatTime(currentTime)}</span>
            <span class="text-textcolor2">/{formatTime(duration)}</span>
        </div>

        <button
            type="button"
            class="flex size-5 shrink-0 items-center justify-center border-0 bg-transparent p-0 text-textcolor shadow-none"
            aria-label={volume > 0 ? 'Mute' : 'Unmute'}
            title={volume > 0 ? 'Mute' : 'Unmute'}
            onclick={toggleMute}
        >
            {#if volume > 0}
                <Volume2Icon size={14}/>
            {:else}
                <VolumeXIcon size={14}/>
            {/if}
        </button>
        <input
            class="audio-player-range w-20 shrink-0 sm:w-24"
            style={`--audio-range-fill: ${volumePercent}%`}
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={volume}
            aria-label="Volume"
            oninput={(event) => setVolume(Number(event.currentTarget.value))}
        />
    </div>
</div>

<style>
    .audio-player-range {
        --audio-range-fill: 0%;
        appearance: none;
        display: block;
        height: 0.2rem;
        cursor: pointer;
        border-radius: 9999px;
        background: linear-gradient(
            to right,
            var(--risu-theme-primary) 0 var(--audio-range-fill),
            var(--risu-theme-bgcolor) var(--audio-range-fill) 100%
        );
    }

    .audio-player-range::-webkit-slider-thumb {
        appearance: none;
        width: 0.65rem;
        height: 0.65rem;
        border: 0;
        border-radius: 9999px;
        background: var(--risu-theme-textcolor);
        transition: transform 150ms ease;
    }

    .audio-player-range::-moz-range-thumb {
        width: 0.65rem;
        height: 0.65rem;
        border: 0;
        border-radius: 9999px;
        background: var(--risu-theme-textcolor);
        transition: transform 150ms ease;
    }

    .audio-player-range:focus-visible {
        outline: none;
    }

    .audio-player-range:hover::-webkit-slider-thumb,
    .audio-player-range:focus-visible::-webkit-slider-thumb {
        transform: scale(1.15);
    }

    .audio-player-range:hover::-moz-range-thumb,
    .audio-player-range:focus-visible::-moz-range-thumb {
        transform: scale(1.15);
    }
</style>
