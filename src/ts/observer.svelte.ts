import { mount, unmount } from 'svelte';
import AudioPlayer from 'src/lib/UI/GUI/AudioPlayer.svelte';

let domObserver: MutationObserver | null = null;
const audioPlayerInstances = new Map<HTMLElement, ReturnType<typeof mount>>();

function mountAudioPlayer(node: HTMLElement) {
    if (!node.hasAttribute('data-risu-audio-player') || audioPlayerInstances.has(node)) {
        return
    }

    const src = node.dataset.audioSrc
    if (!src) return

    const instance = mount(AudioPlayer, {
        target: node,
        props: {
            src,
            title: node.dataset.audioTitle || 'Audio',
            characterName: node.dataset.characterName || '',
            autoplay: true,
            loop: true,
        },
    })
    audioPlayerInstances.set(node, instance)
}

function nodeObserve(node:HTMLElement){
    mountAudioPlayer(node)
}

function observeNodeTree(node: Node) {
    if(!(node instanceof Element)){
        return
    }

    if(node instanceof HTMLElement){
        nodeObserve(node)
    }

    node.querySelectorAll<HTMLElement>('[data-risu-audio-player]').forEach((element) => {
        nodeObserve(element)
    })
}

function unmountNodeTree(node: Node) {
    if (!(node instanceof Element)) return

    const audioNodes = node.matches('[data-risu-audio-player]')
        ? [node as HTMLElement]
        : []
    audioNodes.push(...node.querySelectorAll<HTMLElement>('[data-risu-audio-player]'))

    for (const audioNode of audioNodes) {
        const instance = audioPlayerInstances.get(audioNode)
        if (!instance) continue
        audioPlayerInstances.delete(audioNode)
        void unmount(instance)
    }
}

export async function startObserveDom(){
    if(domObserver){
        return
    }

    // Scan parsed audio blocks once and then watch future subtree insertions.
    document.querySelectorAll<HTMLElement>('[data-risu-audio-player]').forEach((node) => {
        nodeObserve(node)
    })

    const target = document.body ?? document.documentElement
    if(!target){
        return
    }

    domObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if(mutation.type === 'attributes'){
                if(mutation.target instanceof HTMLElement){
                    nodeObserve(mutation.target)
                }
                return
            }
            mutation.addedNodes.forEach((node) => {
                observeNodeTree(node)
            })
            mutation.removedNodes.forEach((node) => {
                unmountNodeTree(node)
            })
        })
    })
    domObserver.observe(target, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-risu-audio-player'],
    })
}
