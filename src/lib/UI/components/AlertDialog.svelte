<script lang="ts" module>
    // shadcn-svelte AlertDialog — ported to RisuAI theme tokens.
    // For confirm-style blocking modals (no X button, requires explicit action/cancel).
    // See _reference/shadcn-components/alert-dialog/* for source patterns.
    export type AlertDialogSize = 'sm' | 'default' | 'lg';
</script>

<script lang="ts">
    import type { Snippet } from 'svelte';
    import { AlertDialog } from 'bits-ui';
    import { cn } from 'src/lib/utils';
    import { provideOverlayLayer } from 'src/ts/gui/overlayLayer.svelte';

    interface Props {
        open?: boolean;
        onOpenChange?: (open: boolean) => void;
        size?: AlertDialogSize;
        /** Escape and backdrop dismissal; disable only for blocking workflows. */
        dismissible?: boolean;
        /** Keyboard actions for binary confirmation dialogs. Enter confirms;
         *  Escape cancels when `dismissible` is enabled. */
        onConfirm?: () => void;
        onCancel?: () => void;
        contentClass?: string;
        title?: Snippet;
        description?: Snippet;
        footer?: Snippet;
        children?: Snippet;
        /** Fallback aria-label when no `title` snippet is provided. bits-ui
         *  sets aria-labelledby pointing to AlertDialog.Title; without one,
         *  screen readers have no name to announce. Rendered as a sr-only
         *  Title in that case. Defaults to "Alert". */
        ariaLabel?: string;
    }

    let {
        open = $bindable(false),
        onOpenChange,
        size = 'default',
        dismissible = true,
        onConfirm,
        onCancel,
        contentClass = '',
        title,
        description,
        footer,
        children,
        ariaLabel,
    }: Props = $props();

    const overlayLayer = provideOverlayLayer(() => open);
    const overlayStyle = $derived(`--risu-overlay-z: ${overlayLayer.zIndex};`);

    const sizeClasses: Record<AlertDialogSize, string> = {
        sm: 'max-w-sm',
        default: 'max-w-md',
        lg: 'max-w-2xl',
    };

    // w-[calc(100vw-2rem)] guarantees a 1rem gutter on each side at any
    // viewport (size class supplies max-width upper bound on desktop).
    const contentBase =
        'risu-modal-content-viewport fixed left-1/2 w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 ' +
        'bg-darkbg border border-darkborderc rounded-md shadow-lg ' +
        'p-4 flex flex-col gap-4 overflow-y-auto outline-none ' +
        'data-[state=open]:animate-in data-[state=closed]:animate-out ' +
        'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 ' +
        'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95';

    function handleDismiss(event: Event) {
        if (!dismissible || !onCancel) return
        event.preventDefault()
        onCancel()
    }

    function handleKeydown(event: KeyboardEvent) {
        if (
            event.key !== 'Enter' || event.isComposing || event.repeat ||
            event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !onConfirm
        ) return

        event.preventDefault()
        event.stopPropagation()
        onConfirm()
    }
</script>

<AlertDialog.Root bind:open {onOpenChange}>
    <AlertDialog.Portal>
        <AlertDialog.Overlay
            class="risu-modal-backdrop risu-layer-overlay data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
            style={overlayStyle}
        />
        <AlertDialog.Content
            data-risu-overlay-layer={overlayLayer.allocatedZIndex}
            class={cn(contentBase, 'risu-layer-overlay', sizeClasses[size], contentClass)}
            style={overlayStyle}
            escapeKeydownBehavior={dismissible ? 'close' : 'ignore'}
            interactOutsideBehavior={dismissible ? 'close' : 'ignore'}
            onEscapeKeydown={handleDismiss}
            onInteractOutside={handleDismiss}
            onkeydown={handleKeydown}
        >
            {#if title || description}
                <div class="flex flex-col gap-1">
                    {#if title}
                        <AlertDialog.Title class="text-lg font-semibold text-maintext leading-tight">
                            {@render title()}
                        </AlertDialog.Title>
                    {/if}
                    {#if description}
                        <AlertDialog.Description class="text-sm text-subtext">
                            {@render description()}
                        </AlertDialog.Description>
                    {/if}
                </div>
            {/if}
            {#if !title}
                <!-- A11y: bits-ui's aria-labelledby points to AlertDialog.Title.
                     When the caller omits the title snippet, render a sr-only
                     fallback so screen readers always have a name to announce. -->
                <AlertDialog.Title class="sr-only">{ariaLabel ?? 'Alert'}</AlertDialog.Title>
            {/if}

            {#if children}
                <div class="text-maintext wrap-break-word">
                    {@render children()}
                </div>
            {/if}

            {#if footer}
                <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                    {@render footer()}
                </div>
            {/if}
        </AlertDialog.Content>
    </AlertDialog.Portal>
</AlertDialog.Root>
