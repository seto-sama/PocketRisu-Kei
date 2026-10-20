<script lang="ts" module>
    export type DialogSize = 'sm' | 'default' | 'lg' | 'xl';
</script>

<script lang="ts">
    import type { Snippet } from 'svelte';
    import { AlertDialog as BitsAlertDialog, Dialog } from 'bits-ui';
    import { XIcon } from '@lucide/svelte';
    import { language } from 'src/lang';
    import { cn } from 'src/lib/utils';
    import { wasLastInteractionKeyboard } from 'src/ts/gui/inputModality';
    import { provideOverlayLayer } from 'src/ts/gui/overlayLayer.svelte';
    import { isTopOverlayLayer } from 'src/ts/gui/overlayStack';
    import IconButton from './IconButton.svelte';
    import IconButtonGroup from './IconButtonGroup.svelte';

    interface Props {
        open?: boolean;
        onOpenChange?: (open: boolean) => void;
        size?: DialogSize;
        fullscreen?: boolean;
        closable?: boolean;
        /** Escape and backdrop dismissal; disable only for blocking workflows. */
        dismissible?: boolean;
        /** Lets callers confirm a user-initiated close before changing `open`. */
        onRequestClose?: () => void;
        /** Called for an unmodified Enter press while this is the top overlay. */
        onConfirm?: () => void;
        role?: 'dialog' | 'alertdialog';
        contentClass?: string;
        bodyClass?: string;
        overlayClass?: string;
        onOpenAutoFocus?: (event: Event) => void;
        onCloseAutoFocus?: (event: Event) => void;
        title?: Snippet;
        headerActions?: Snippet;
        description?: Snippet;
        footer?: Snippet;
        children?: Snippet;
        /** Accessible title used when no visible `title` snippet is provided. */
        ariaLabel?: string;
    }

    let {
        open = $bindable(false),
        onOpenChange,
        size = 'default',
        fullscreen = false,
        closable = true,
        dismissible = true,
        onRequestClose,
        onConfirm,
        role = 'dialog',
        contentClass = '',
        bodyClass = '',
        overlayClass = '',
        onOpenAutoFocus,
        onCloseAutoFocus,
        title,
        headerActions,
        description,
        footer,
        children,
        ariaLabel,
    }: Props = $props();
    let contentRef = $state<HTMLElement | null>(null);
    let restoreFocusOnClose = false;

    const overlayLayer = provideOverlayLayer(() => open);
    const DialogRoot = $derived(role === 'alertdialog' ? BitsAlertDialog.Root : Dialog.Root);
    const overlayStyle = $derived(`--risu-overlay-z: ${overlayLayer.zIndex};`);

    const focusableSelector = [
        'a[href]',
        'button:not([disabled])',
        'input:not([disabled]):not([type="hidden"])',
        'select:not([disabled])',
        'textarea:not([disabled])',
        '[contenteditable="true"]',
        '[tabindex]:not([tabindex="-1"])',
    ].join(',');

    function dialogFocusOrder(root: HTMLElement): HTMLElement[] {
        const candidates = Array.from(root.querySelectorAll<HTMLElement>(focusableSelector))
            .filter(element => !element.closest('[hidden], [inert], [aria-hidden="true"]'));
        const help = candidates.filter(element => element.hasAttribute('data-risu-help'));
        const close = candidates.filter(element => element.hasAttribute('data-risu-dialog-close'));
        const regular = candidates.filter(element => !element.hasAttribute('data-risu-help')
            && !element.hasAttribute('data-risu-dialog-close'));
        return [...regular, ...help, ...close];
    }

    function handleOpenAutoFocus(event: Event) {
        restoreFocusOnClose = wasLastInteractionKeyboard(contentRef?.ownerDocument ?? document);
        if (onOpenAutoFocus) {
            onOpenAutoFocus(event);
            return;
        }
        event.preventDefault();
        const focusFirst = () => {
            const root = contentRef;
            if (!root) return false;
            const first = dialogFocusOrder(root)[0];
            (first ?? root).focus();
            return true;
        };
        if (!focusFirst()) queueMicrotask(focusFirst);
    }

    function handleCloseAutoFocus(event: Event) {
        if (!restoreFocusOnClose) event.preventDefault();
        onCloseAutoFocus?.(event);
        restoreFocusOnClose = false;
    }

    function handleTabKeydown(event: KeyboardEvent) {
        if (!open || event.key !== 'Tab' || event.ctrlKey || event.altKey || event.metaKey) return;
        const root = contentRef;
        const target = event.target;
        if (!root || !(target instanceof Node) || !root.contains(target)) return;
        const order = dialogFocusOrder(root);
        const active = document.activeElement;
        const index = order.findIndex(element => element === active);
        if (index < 0 || order.length < 2) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const offset = event.shiftKey ? -1 : 1;
        order[(index + offset + order.length) % order.length]?.focus();
    }

    $effect(() => {
        if (!open || typeof window === 'undefined') return;
        window.addEventListener('keydown', handleTabKeydown, true);
        return () => window.removeEventListener('keydown', handleTabKeydown, true);
    });

    const sizeClasses: Record<DialogSize, string> = {
        sm: 'max-w-sm',
        default: 'max-w-[var(--risu-dialog-default-width)]',
        lg: 'max-w-2xl',
        xl: 'max-w-4xl',
    };

    const contentBase =
        'fixed ' +
        'bg-darkbg border-[length:var(--risu-dialog-border-width)] border-darkborderc rounded-md shadow-lg ' +
        'p-[var(--risu-dialog-padding)] flex flex-col gap-4 overflow-y-auto outline-none whitespace-pre-wrap ' +
        'data-[state=open]:animate-in data-[state=closed]:animate-out ' +
        'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 ' +
        'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95';

    function requestClose() {
        if (onRequestClose) {
            onRequestClose();
            return;
        }
        open = false;
        onOpenChange?.(false);
    }

    function handleInteractOutside(event: PointerEvent) {
        if (!isTopOverlayLayer(overlayLayer.allocatedZIndex)) {
            event.preventDefault()
            return
        }
        const target = event.target
        if (target instanceof Element && target.closest('[data-sonner-toaster]')) {
            // Keep portaled toasts interactive while the dialog is open.
            event.preventDefault()
            return
        }
        if (target instanceof Element && target.closest('[data-risu-dialog-interactive]')) {
            event.preventDefault()
            return
        }
        if (!dismissible) return
        event.preventDefault()
        requestClose()
    }

    function handleEscapeKeydown(event: KeyboardEvent) {
        if (!isTopOverlayLayer(overlayLayer.allocatedZIndex)) {
            event.preventDefault()
            return
        }
        if (event.repeat) {
            event.preventDefault()
            return
        }
        const target = event.target
        if (target instanceof Element && target.closest('[data-inline-name-editor]')) {
            event.preventDefault()
            return
        }
        if (!dismissible) return
        event.preventDefault()
        requestClose()
    }

    function handleKeydown(event: KeyboardEvent) {
        if (event.key !== 'Enter' || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
        if (!isTopOverlayLayer(overlayLayer.allocatedZIndex) || event.repeat) {
            if (onConfirm || role === 'alertdialog') {
                event.preventDefault()
                event.stopImmediatePropagation()
            }
            return
        }
        if (!onConfirm) return

        event.preventDefault()
        event.stopImmediatePropagation()
        onConfirm()
    }
</script>

<DialogRoot bind:open {onOpenChange}>
    <Dialog.Portal>
        <Dialog.Overlay
            class={cn('risu-modal-backdrop risu-layer-overlay data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0', overlayClass)}
            style={overlayStyle}
        />
        <Dialog.Content
            bind:ref={contentRef}
            data-risu-overlay-layer={overlayLayer.allocatedZIndex}
            class={cn(contentBase, 'risu-layer-overlay', fullscreen
                ? 'inset-0 h-dvh w-full max-h-none max-w-none rounded-none border-0'
                : ['risu-modal-content-viewport left-1/2 w-[calc(100vw-var(--risu-dialog-viewport-inset))] -translate-x-1/2 -translate-y-1/2', sizeClasses[size]], contentClass)}
            style={overlayStyle}
            escapeKeydownBehavior={dismissible ? 'close' : 'ignore'}
            interactOutsideBehavior={dismissible ? 'close' : 'ignore'}
            onEscapeKeydown={handleEscapeKeydown}
            onInteractOutside={handleInteractOutside}
            onkeydown={handleKeydown}
            onOpenAutoFocus={handleOpenAutoFocus}
            onCloseAutoFocus={handleCloseAutoFocus}
        >
            {#if title || description || closable || headerActions}
                <div class="flex flex-col gap-1">
                    {#if title || headerActions || closable}
                        <div class="flex items-center justify-between gap-2">
                            {#if title}
                                <Dialog.Title class="text-lg font-semibold text-maintext leading-tight">
                                    {@render title()}
                                </Dialog.Title>
                            {/if}
                            {#if headerActions || closable}
                                <IconButtonGroup className="ml-auto shrink-0 self-start">
                                    {@render headerActions?.()}
                                    {#if closable}
                                        <IconButton
                                            data-risu-dialog-close
                                            aria-label={language.close}
                                            onclick={requestClose}
                                        >
                                            <XIcon />
                                        </IconButton>
                                    {/if}
                                </IconButtonGroup>
                            {/if}
                        </div>
                    {/if}
                    {#if description}
                        <Dialog.Description class="text-sm text-subtext">
                            {@render description()}
                        </Dialog.Description>
                    {/if}
                </div>
            {/if}
            {#if !title}
                <Dialog.Title class="sr-only">{ariaLabel ?? (role === 'alertdialog' ? 'Alert' : 'Dialog')}</Dialog.Title>
            {/if}

            {#if children}
                <div class={cn('text-maintext wrap-break-word', bodyClass)}>
                    {@render children()}
                </div>
            {/if}

            {#if footer}
                <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                    {@render footer()}
                </div>
            {/if}
        </Dialog.Content>
    </Dialog.Portal>
</DialogRoot>
