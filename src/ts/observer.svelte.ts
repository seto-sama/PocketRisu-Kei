import { mount, unmount } from 'svelte';
import AudioPlayer from 'src/lib/UI/GUI/AudioPlayer.svelte';

let domObserver: MutationObserver | null = null;
const audioPlayerInstances = new Map<HTMLElement, ReturnType<typeof mount>>();

const OBSERVED_HL_ATTR = 'data-risu-observed-hl'

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
    const hlLang = node.getAttribute('x-hl-lang');

    mountAudioPlayer(node)

    if(hlLang && node.getAttribute(OBSERVED_HL_ATTR) !== '1'){
        node.setAttribute(OBSERVED_HL_ATTR, '1')
        node.addEventListener('contextmenu', (e)=>{
            e.preventDefault()

            const prevContextMenu = document.getElementById('code-contextmenu')
            if(prevContextMenu){
                prevContextMenu.remove()
            }

            const menu = document.createElement('div')
            menu.id = 'code-contextmenu'
            menu.setAttribute('class', 'fixed z-50 min-w-[160px] py-2 bg-gray-800 rounded-lg border border-gray-700')

            const copyOption = document.createElement('div')
            copyOption.textContent = 'Copy'
            copyOption.setAttribute('class', 'px-4 py-2 text-sm text-gray-300 hover:bg-gray-700 cursor-pointer')
            copyOption.addEventListener('click', ()=>{
                navigator.clipboard.writeText(node.textContent ?? '')
                menu.remove()
            })

            const downloadOption = document.createElement('div');
            downloadOption.textContent = 'Download';
            downloadOption.setAttribute('class', 'px-4 py-2 text-sm text-gray-300 hover:bg-gray-700 cursor-pointer')
            downloadOption.addEventListener('click', ()=>{
                const a = document.createElement('a')
                a.href = URL.createObjectURL(new Blob([node.textContent ?? ''], {type: 'text/plain'}))
                a.download = 'code.' + hlLang
                a.click()
                menu.remove()
            })

            menu.appendChild(copyOption)
            menu.appendChild(downloadOption)

            menu.style.left = e.clientX + 'px'
            menu.style.top = e.clientY + 'px'

            document.body.appendChild(menu)

            document.addEventListener('click', ()=>{
                menu?.remove()
            }, {once: true})
        })
    }

}

function observeNodeTree(node: Node) {
    if(!(node instanceof Element)){
        return
    }

    if(node instanceof HTMLElement){
        nodeObserve(node)
    }

    node.querySelectorAll<HTMLElement>('[x-hl-lang], [data-risu-audio-player]').forEach((element) => {
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

    // For parsed HTML blocks, scan once and then watch future subtree insertions.
    document.querySelectorAll<HTMLElement>('[x-hl-lang], [data-risu-audio-player]').forEach((node) => {
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
        attributeFilter: ['x-hl-lang', 'data-risu-audio-player'],
    })
}
