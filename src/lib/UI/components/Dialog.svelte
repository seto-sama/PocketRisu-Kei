<script lang="ts" module>
    // shadcn-svelte Dialog — ported to RisuAI theme and layer tokens.
    // See _reference/shadcn-components/dialog/* for source patterns.
    export type DialogSize = 'sm' | 'default' | 'lg' | 'xl';
</script>

<script lang="ts">
    import type { Snippet } from 'svelte';
    import { Dialog } from 'bits-ui';
    import { XIcon } from '@lucide/svelte';
    import { cn } from 'src/lib/utils';
    import { provideOverlayLayer } from 'src/ts/gui/overlayLayer.svelte';

    interface Props {
        open?: boolean;
        onOpenChange?: (open: boolean) => void;
        size?: DialogSize;
        closable?: boolean;
        closeOnEscape?: boolean;
        closeOnOutsideClick?: boolean;
        /** Intercepts user-initiated close actions (Escape, backdrop, close
         * button) so callers can confirm before actually changing `open`. */
        onRequestClose?: () => void;
        contentClass?: string;
        bodyClass?: string;
        overlayClass?: string;
        onOpenAutoFocus?: (event: Event) => void;
        onCloseAutoFocus?: (event: Event) => void;
        title?: Snippet;
        description?: Snippet;
        footer?: Snippet;
        children?: Snippet;
        /** Fallback aria-label for the dialog when no `title` snippet is
         *  provided. bits-ui sets aria-labelledby pointing to Dialog.Title;
         *  if no Title is rendered, the labelledby reference is broken.
         *  This prop is rendered as a visually-hidden Dialog.Title in that
         *  case. Defaults to "Dialog" for callers that don't specify. */
        ariaLabel?: string;
    }

    let {
        open = $bindable(false),
        onOpenChange,
        size = 'default',
        closable = true,
        closeOnEscape,
        closeOnOutsideClick = true,
        onRequestClose,
        contentClass = '',
        bodyClass = '',
        overlayClass = '',
        onOpenAutoFocus,
        onCloseAutoFocus,
        title,
        description,
        footer,
        children,
        ariaLabel,
    }: Props = $props();
    let contentRef = $state<HTMLElement | null>(null);

    const overlayLayer = provideOverlayLayer(() => open);
    const overlayStyle = $derived(`--risu-overlay-z: ${overlayLayer.zIndex};`);
    const escapeEnabled = $derived(closeOnEscape ?? closeOnOutsideClick);

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
        default: 'max-w-md',
        lg: 'max-w-2xl',
        xl: 'max-w-4xl',
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

    function handleInteractOutside(event: PointerEvent) {
        const target = event.target
        if (target instanceof Element && target.closest('[data-sonner-toaster]')) {
            // Toasts live in their own portal. They are intentionally usable
            // above dialogs and must not be treated as backdrop interaction.
            event.preventDefault()
            return
        }
        if (target instanceof Element && target.closest('[data-risu-dialog-interactive]')) {
            event.preventDefault()
            return
        }
        if (onRequestClose && closeOnOutsideClick) {
            event.preventDefault()
            onRequestClose()
        }
    }

    function handleEscapeKeydown(event: KeyboardEvent) {
        const target = event.target
        if (target instanceof Element && target.closest('[data-inline-name-editor]')) {
            event.preventDefault()
            return
        }
        if (!onRequestClose || !escapeEnabled) return
        event.preventDefault()
        onRequestClose()
    }
</script>

<Dialog.Root bind:open {onOpenChange}>
    <Dialog.Portal>
        <Dialog.Overlay
            class={cn('risu-modal-backdrop risu-layer-overlay data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0', overlayClass)}
            style={overlayStyle}
        />
        <Dialog.Content
            bind:ref={contentRef}
            data-risu-overlay-layer={overlayLayer.allocatedZIndex}
            class={cn(contentBase, 'risu-layer-overlay', sizeClasses[size], contentClass)}
            style={overlayStyle}
            escapeKeydownBehavior={escapeEnabled ? 'close' : 'ignore'}
            interactOutsideBehavior={closeOnOutsideClick ? 'close' : 'ignore'}
            onEscapeKeydown={handleEscapeKeydown}
            onInteractOutside={handleInteractOutside}
            onOpenAutoFocus={handleOpenAutoFocus}
            {onCloseAutoFocus}
        >
            {#if title || description || closable}
                <div class={cn('flex flex-col gap-1 relative', closable && 'pr-8')}>
                    {#if title}
                        <Dialog.Title class="text-lg font-semibold text-maintext leading-tight">
                            {@render title()}
                        </Dialog.Title>
                    {/if}
                    {#if description}
                        <Dialog.Description class="text-sm text-subtext">
                            {@render description()}
                        </Dialog.Description>
                    {/if}
                    {#if closable}
                        {#if onRequestClose}
                            <button
                                type="button"
                                data-risu-dialog-close
                                class="absolute right-0 top-0 rounded-sm border border-transparent text-subtext risu-interactive-foreground transition-colors cursor-pointer"
                                aria-label="Close"
                                onclick={onRequestClose}
                            >
                                <XIcon size={18} />
                            </button>
                        {:else}
                            <Dialog.Close
                                data-risu-dialog-close
                                class="absolute right-0 top-0 rounded-sm border border-transparent text-subtext risu-interactive-foreground transition-colors cursor-pointer"
                                aria-label="Close"
                            >
                                <XIcon size={18} />
                            </Dialog.Close>
                        {/if}
                    {/if}
                </div>
            {/if}
            {#if !title}
                <!-- A11y: bits-ui's aria-labelledby points to Dialog.Title.
                     When the caller omits the title snippet, render a sr-only
                     fallback so screen readers always have a name to announce. -->
                <Dialog.Title class="sr-only">{ariaLabel ?? 'Dialog'}</Dialog.Title>
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
</Dialog.Root>
