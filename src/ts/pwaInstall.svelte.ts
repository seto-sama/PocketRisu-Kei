interface BeforeInstallPromptEvent extends Event {
    prompt(): Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;

export const pwaInstallState = $state({
    canInstall: false,
});

export function initializePwaInstall() {
    const handleBeforeInstallPrompt = (event: Event) => {
        event.preventDefault();
        deferredPrompt = event as BeforeInstallPromptEvent;
        pwaInstallState.canInstall = true;
    };
    const handleAppInstalled = () => {
        deferredPrompt = null;
        pwaInstallState.canInstall = false;
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
        window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
        window.removeEventListener('appinstalled', handleAppInstalled);
    };
}

export async function requestPwaInstall() {
    const prompt = deferredPrompt;
    if (!prompt) return;

    deferredPrompt = null;
    pwaInstallState.canInstall = false;
    await prompt.prompt();
    await prompt.userChoice;
}
