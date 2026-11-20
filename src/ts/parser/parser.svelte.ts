import { Buffer } from 'buffer'
import DOMPurify from 'dompurify';
import markdownit, { type MarkdownIt } from 'markdown-it'
import { allowAttachedText } from './attachedTextMarkdown'
import { pocketKeiVer, getCurrentCharacter, getDatabase, type Database, type character, type customscript, type triggerscript } from '../storage/database.svelte';
import { CurrentTriggerIdStore, DBState, selIdState } from '../stores.svelte';
import { aiWatermarkingLawApplies, getFileSrc } from '../globalApi.svelte';
import { isNodeServer } from "src/ts/platform"
import { getChatVar, setChatVar, getGlobalChatVar } from './chatVar.svelte';
import { processScriptFull } from '../process/scripts';
import { get } from 'svelte/store';
import css, { type CssAtRuleAST, type CssDeclarationAST } from '@adobe/css-tools'
import { selectedCharID } from '../stores.svelte';
import { calcString } from '../process/infunctions';
import { findCharacterbyId, getPersonaPrompt, getUserIcon, getUserName, pickHashRand, replaceAsync} from '../util';

import { getInlayAssetUrl, getInlayInfosBatch, type InlayAsset } from '../process/files/inlays';
import { getInlayIds, INLAY_VIEWER_ID_ATTRIBUTE, inlayTokenRegex } from '../util/inlayTokens';
import { getModuleAssets, getModuleLorebooks, getModules } from '../process/modules';
import hljs from 'highlight.js/lib/core'
import 'highlight.js/styles/atom-one-dark.min.css'
import { language } from 'src/lang';
import katex from 'katex'
import { getGenerationModelMetadata, getGenerationModelString } from '../process/models/modelString';
import { registerCBS, type RegisterCallback } from '../cbs';
import { dateTimeFormat, makeArray, parseArray, parseCbs, parseDict, risuUnescape, type CbsConditions, type CbsParserArg, type CbsParserEnv } from './cbsCore';
import { getChatPage } from '../storage/chatSelection.svelte';
import { emotionImageToAsset, imageAssetExtensions } from '../characterAssets';
import cssSelectorParser from 'postcss-selector-parser'
import {
    CHAT_SCROLL_ROOT_SELECTOR,
    CHAT_VIEWPORT_MARGIN_MULTIPLIER,
    observeWithinChatViewport,
} from '../chatViewportObserver'
import { applyHiddenImageTheme, hiddenImageDataUri, hiddenImageIcon, hiddenImageSrc, hideCssImageUrls, hideStyleRuleImages, hideStyleSheetImages, isSpacerImage } from './hideImages'

const markdownItOptions = {
    html: true,
    breaks: true,
    linkify: false,
    typographer: true,
    quotes: '\u{E9b0}\u{E9b1}\u{E9b2}\u{E9b3}', //placeholder characters to convert to real quotes
}

const md = markdownit(markdownItOptions)
const mdHighlight = markdownit({
    highlight: function (str, lang) {
        if(lang){
            return `<pre-hljs-placeholder lang="${lang}">`+ str +'</pre-hljs-placeholder>';
        }
        return ''
    },
    ...markdownItOptions
})

md.disable(['code'])
mdHighlight.disable(['code'])
allowAttachedText(md)
allowAttachedText(mdHighlight)

// Onboarding is a setup screen rather than chat content, so hideAllImages
// leaves it alone. The sanitize hooks and style decoding take no arguments,
// so parseOnboardingHTML sets this around its synchronous rendering.
let showImagesForOnboarding = false

function shouldHideImages(){
    return !showImagesForOnboarding && !!DBState.db?.hideAllImages
}

DOMPurify.addHook("uponSanitizeElement", (node: HTMLElement, data) => {
    if (data.tagName === "iframe") {
       const src = node.getAttribute("src") || "";
       if (!src.startsWith("https://www.youtube.com/embed/")) {
          return node.parentNode.removeChild(node);
       }
    }
    if(shouldHideImages()){
        hideElementImages(node, data.tagName)
    }
    if(data.tagName === 'img'){
        const loading = node.getAttribute("loading")
        if(!loading){
            node.setAttribute("loading","lazy")
        }
        const decoding = node.getAttribute("decoding")
        if(!decoding){
            node.setAttribute("decoding", "async")
        }
    }
});

/**
 * Swaps image sources on an element for the hidden image placeholder. Runs
 * before the element's attributes are sanitized, so attribute-level sources
 * are left to hideAttributeImage.
 */
function hideElementImages(node:Element, tagName:string){
    const isImageInput = tagName === 'input' && node.getAttribute('type')?.toLowerCase() === 'image'
    if(tagName === 'img' || isImageInput){
        if(!isSpacerImage(node.getAttribute('src') ?? '') || node.hasAttribute('srcset')){
            node.setAttribute('src', hiddenImageSrc)
            node.setAttribute('alt', '')
            // picked up by styles.css for a default size
            node.setAttribute('data-risu-hidden-image', '')
        }
    }
    else if(tagName === 'style'){
        // Raw <style> blocks that skipped encodeStyle, e.g. <style type="text/css">
        node.textContent = hideStyleSheetImages(node.textContent ?? '')
    }
}

/** Returns true when the attribute was fully handled and needs no further processing. */
function hideAttributeImage(node:Element, data:{attrName:string, attrValue:string, keepAttr:boolean}){
    const tagName = node.nodeName.toLowerCase()
    switch(data.attrName){
        case 'style':
            data.attrValue = hideCssImageUrls(data.attrValue)
            return false
        case 'srcset':
        case 'imagesrcset':
            // a srcset candidate always wins over the placeholder in src
            data.keepAttr = false
            return true
        case 'poster':
        case 'background':
            data.attrValue = hiddenImageSrc
            return true
        case 'href':
        case 'xlink:href':
            if(tagName === 'image' || tagName === 'feimage'){
                data.attrValue = hiddenImageSrc
                return true
            }
            return false
    }
    return false
}

DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
    if(shouldHideImages() && hideAttributeImage(node, data)){
        return
    }
    switch(data.attrName){
        case 'class':{
            if(data.attrValue){
                data.attrValue = data.attrValue.split(' ').map((v) => {
                    if(v.startsWith('hljs')){
                        return v
                    }
                    if(v.startsWith('x-risu-')){
                        return v
                    }
                    return "x-risu-" + v
                }).join(' ')
            }
            break
        }
        case 'href':{
            if(data.attrValue.startsWith('http://') || data.attrValue.startsWith('https://')){
                node.setAttribute('target', '_blank')
                break
            }
            data.attrValue = ''
            break
        }
    }
})

DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
    if (['IMG', 'SOURCE', 'VIDEO', 'AUDIO', 'STYLE'].includes(node.nodeName) && data.attrName === 'src') {
        if (data.attrValue.startsWith('blob:')) {
            data.forceKeepAttr = true;
        }
    }
});


export { risuEscape, risuUnescape } from './cbsCore'

const quoteBlockEndingRegex = /[\p{P}\p{S}]$/u
const quoteBracketEndingRegex = /[\p{Ps}\p{Pe}]$/u
const quoteClosingCharsRegex = /[\uE9b1\uE9b3"'’”」』»》]+$/u
const blockquoteBreakPlaceholder = '\uE9B4'
const cornerBracketStyles = [
    { regex: /「(.+?)」/gs, open: '「', close: '」', mark: 'blockquote2' },
    { regex: /『(.+?)』/gs, open: '『', close: '』', mark: 'cornerbracket2' },
    { regex: /«(.+?)»/gs, open: '«', close: '»', mark: 'cornerbracket2' },
    { regex: /《(.+?)》/gs, open: '《', close: '》', mark: 'cornerbracket2' },
] as const

function shouldRenderAsBlockquote(content:string){
    const trimmed = content
        .replace(/(?:<[^>]+>\s*)+$/g, '')
        .trim()
        .replace(quoteClosingCharsRegex, '')
        .trim()
    return quoteBlockEndingRegex.test(trimmed) && !quoteBracketEndingRegex.test(trimmed)
}

function renderMarkedText(open:string, content:string, close:string, mark:string){
    const trailingPlaceholder = mark.startsWith('blockquote') ? blockquoteBreakPlaceholder : ''
    return `<mark risu-mark="${mark}">${open}${content}${close}</mark>${trailingPlaceholder}`
}

function removeBlockquoteBreakPlaceholders(text:string){
    if(!text.includes(blockquoteBreakPlaceholder)) return text
    return text.replace(/\uE9B4(?:[ \t]*<br\s*\/?>\s*\n?)?/gu, '')
}

function applyCornerBracketStyling(text:string){
    if(!/[「『«《]/u.test(text)) return text
    for(const style of cornerBracketStyles){
        text = text.replace(style.regex, (_full, content) => {
            return renderMarkedText(style.open, content, style.close, style.mark)
        })
    }
    return text
}

const standaloneOrderedListMarker = /^([ \t]{0,3}\d{1,9})\.([ \t]*)$/
const fencedCodeOpening = /^[ \t]{0,3}(`{3,}|~{3,})/

function escapeStandaloneOrderedListMarkers(markdown:string){
    if(!/^[ \t]{0,3}\d{1,9}\.[ \t]*\r?$/m.test(markdown)) return markdown
    let fenceCharacter = ''
    let fenceLength = 0

    return markdown.split('\n').map((line) => {
        const carriageReturn = line.endsWith('\r') ? '\r' : ''
        const content = carriageReturn ? line.slice(0, -1) : line

        if(fenceCharacter){
            const fencedCodeClosing = new RegExp(
                `^[ \\t]{0,3}${fenceCharacter}{${fenceLength},}[ \\t]*$`,
            )
            if(fencedCodeClosing.test(content)){
                fenceCharacter = ''
                fenceLength = 0
            }
            return line
        }

        const opening = content.match(fencedCodeOpening)
        if(opening){
            fenceCharacter = opening[1][0]
            fenceLength = opening[1].length
            return line
        }

        return content.replace(standaloneOrderedListMarker, '$1\\.$2') + carriageReturn
    }).join('\n')
}

function renderMarkdown(md:MarkdownIt, data:string){
    let quotes = ['“', '”', '‘', '’']
    if(DBState.db?.customQuotes){
        quotes = DBState.db.customQuotesData ?? quotes
    }
    data = escapeStandaloneOrderedListMarkers(data)
    data = data.replace(/\$\$(.*?)\$\$/gs, (
        match:string,
        content:string,
    ) => {

        try {
            content = content
                .replace(/\uE9b8/gu, '{')
                .replace(/\uE9b9/gu, '}')
                .replace(/\uE9ba/gu, '(')
                .replace(/\uE9bb/gu, ')')
            const rendered = katex.renderToString(content, {
                displayMode: false,
                throwOnError: true,
                output: 'mathml'
            })
            return rendered
        } catch (error) {
            console.error('KaTeX render error:', error)
            return match
        }
    })
    let text = risuUnescape(md.render(data.replace(/“|”/g, '"').replace(/‘|’/g, "'")))

    if(!DBState.db?.unformatQuotes && DBState.db?.cornerBracketStyling){
        text = applyCornerBracketStyling(text)
    }

    if(DBState.db?.unformatQuotes){
        text = text.replace(/\uE9b0/gu, quotes[0]).replace(/\uE9b1/gu, quotes[1])
        text = text.replace(/\uE9b2/gu, quotes[2]).replace(/\uE9b3/gu, quotes[3])
    }
    else if(DBState.db?.blockquoteStyling){
        text = text.replace(/\uE9b0(.+?)\uE9b1/gum, (full, content) => {
            const markType = shouldRenderAsBlockquote(content) ? 'blockquote2' : 'quote2'
            content = content.replace(/\uE9b2/gu, '<mark risu-mark="quote1">' + quotes[2]).replace(/\uE9b3/gu, quotes[3] + '</mark>')
            return renderMarkedText(quotes[0], content, quotes[1], markType)
        }).replace(/\uE9b2(.+?)\uE9b3/gum, (full, content) => {
            const markType = shouldRenderAsBlockquote(content) ? 'blockquote1' : 'quote1'
            return renderMarkedText(quotes[2], content, quotes[3], markType)
        })

        //clean up any unmatched quote marks
        text = text.replace(/\uE9b0/gu,  quotes[0]).replace(/\uE9b1/gu, quotes[1])
        text = text.replace(/\uE9b2/gu, quotes[2]).replace(/\uE9b3/gu, quotes[3])
        
    }
    else{
        text = text.replace(/\uE9b0/gu, '<mark risu-mark="quote2">' + quotes[0]).replace(/\uE9b1/gu, quotes[1] + '</mark>')
        text = text.replace(/\uE9b2/gu, '<mark risu-mark="quote1">' + quotes[2]).replace(/\uE9b3/gu, quotes[3] + '</mark>')
    }

    text = removeBlockquoteBreakPlaceholders(text)

    return text
}

async function renderHighlightableMarkdown(data:string) {
    let rendered = renderMarkdown(mdHighlight, data)
    const highlightPlaceholders = rendered.match(/<pre-hljs-placeholder lang="(.+?)">(.+?)<\/pre-hljs-placeholder>/gms)
    if (!highlightPlaceholders){
        return rendered
    }

    for (const placeholder of highlightPlaceholders){
        try {
            let lang = placeholder.match(/lang="(.+?)"/)?.[1]
            const code = placeholder.match(/<pre-hljs-placeholder lang=".+?">(.+?)<\/pre-hljs-placeholder>/ms)![1]
            if (!lang){
                continue
            }
            // Literal import paths let Vite bundle only the requested languages.
            let languageModule: typeof import('highlight.js/lib/languages/*')|null = null
            switch(lang){
                case 'bash':{
                    lang = 'bash'
                    if(!hljs.getLanguage('bash')){
                        languageModule = await import('highlight.js/lib/languages/bash')
                    }
                    break
                }
                case 'c':
                case 'cpp':{
                    lang = 'cpp'
                    if(!hljs.getLanguage('cpp')){
                        languageModule = await import('highlight.js/lib/languages/cpp')
                    }
                    break
                }
                case 'cs':
                case 'csharp':{
                    lang = 'csharp'
                    if(!hljs.getLanguage('csharp')){
                        languageModule = await import('highlight.js/lib/languages/csharp')
                    }
                    break
                }
                case 'css':{
                    lang = 'css'
                    if(!hljs.getLanguage('css')){
                        languageModule = await import('highlight.js/lib/languages/css')
                    }
                    break
                }
                case 'dart':{
                    lang = 'dart'
                    if(!hljs.getLanguage('dart')){
                        languageModule = await import('highlight.js/lib/languages/dart')
                    }
                    break
                }
                case 'html':
                case 'svg':
                case 'xml':{
                    lang = 'xml'
                    if(!hljs.getLanguage('xml')){
                        languageModule = await import('highlight.js/lib/languages/xml')
                    }
                    break
                }
                case 'java':{
                    lang = 'java'
                    if(!hljs.getLanguage('java')){
                        languageModule = await import('highlight.js/lib/languages/java')
                    }
                    break
                }
                case 'js':
                case 'jsx':
                case 'javascript':{
                    lang = 'javascript'
                    if(!hljs.getLanguage('javascript')){
                        languageModule = await import('highlight.js/lib/languages/javascript')
                    }
                    break
                }
                case 'json':{
                    lang = 'json'
                    if(!hljs.getLanguage('json')){
                        languageModule = await import('highlight.js/lib/languages/json')
                    }
                    break
                }
                case 'lua':{
                    lang = 'lua'
                    if(!hljs.getLanguage('lua')){
                        languageModule = await import('highlight.js/lib/languages/lua')
                    }
                    break
                }
                case 'markdown':
                case 'md':{
                    lang = 'markdown'
                    if(!hljs.getLanguage('markdown')){
                        languageModule = await import('highlight.js/lib/languages/markdown')
                    }
                    break
                }
                case 'py':
                case 'python':{
                    lang = 'python'
                    if(!hljs.getLanguage('python')){
                        languageModule = await import('highlight.js/lib/languages/python')
                    }
                    break
                }
                case 'rust':{
                    lang = 'rust'
                    if(!hljs.getLanguage('rust')){
                        languageModule = await import('highlight.js/lib/languages/rust')
                    }
                    break
                }
                case 'shell':{
                    lang = 'shell'
                    if(!hljs.getLanguage('shell')){
                        languageModule = await import('highlight.js/lib/languages/shell')
                    }
                    break
                }
                case 'ts':
                case 'tsx':
                case 'typescript':{
                    lang = 'typescript'
                    if(!hljs.getLanguage('typescript')){
                        languageModule = await import('highlight.js/lib/languages/typescript')
                    }
                    break
                }
                case 'txt':
                case 'vtt':{
                    lang = 'plaintext'
                    if(!hljs.getLanguage('plaintext')){
                        languageModule = await import('highlight.js/lib/languages/plaintext')
                    }
                    break
                }
                case 'yaml':{
                    lang = 'yaml'
                    if(!hljs.getLanguage('yaml')){
                        languageModule = await import('highlight.js/lib/languages/yaml')
                    }
                    break
                }
                default:{
                    lang = 'none'
                }
            }
            if(languageModule){
                hljs.registerLanguage(lang, languageModule.default)
            }
            if(lang === 'none'){
                rendered = rendered.replace(placeholder, `<pre><code>${md.utils.escapeHtml(code)}</code></pre>`)
            }
            else{
                const highlighted = hljs.highlight(code, {
                    language: lang,
                    ignoreIllegals: true
                }).value
                rendered = rendered.replace(placeholder, `<pre class="hljs"><code>${highlighted}</code></pre>`)
            }
        } catch (error) {
            
        }
    }

    return rendered

}

export const assetRegex = /{{(raw|path|img|image|video|audio|bgm|bg|emotion|asset|video-img|source)::(.+?)}}/gms

// Same-name assets are random variants of one another, but only within one media kind.
function assetKind(ext: string | undefined) {
    const normalized = ext?.toLowerCase()
    return imageAssetExtensions.includes(normalized) ? 'image' : normalized
}

function getAssetSrc(assetArr: string[][], assetPaths: AssetPaths) {
    for (const asset of assetArr) {
        const key = asset[0].toLocaleLowerCase()
        assetPaths[key] ??= {
            srcPaths: [],
            ext: asset[2]
        }
        if(assetKind(assetPaths[key].ext) === assetKind(asset[2])){
            assetPaths[key].srcPaths.push(asset[1])
        }
    }
}

const fileSrcCache = new Map<string, string>()

async function getFileSrcCached(path:string){
    let cached = fileSrcCache.get(path)
    if(cached){
        return cached
    }
    const src = await getFileSrc(path)
    fileSrcCache.set(path, src)
    return src
}

type AssetPaths = {[key:string]:{
    srcPaths:string[]
    ext?:string
}}

let assetsCache: AssetPaths | null = null
let assetsCacheCharacterId = ''

export function resetAssetsCache(charAssets: string[][], legacyEmotionImages: [string, string][], moduleAssets: string[][], characterId = '') {
    const assetPaths: AssetPaths = {}

    getAssetSrc(charAssets, assetPaths)
    // Characters not opened since the emotion-image removal still carry them until migration.
    getAssetSrc(legacyEmotionImages.map(emotionImageToAsset), assetPaths)
    getAssetSrc(moduleAssets, assetPaths)

    assetsCache = assetPaths
    assetsCacheCharacterId = characterId
}

function resetCharacterAssetsCache(char: simpleCharacterArgument|character) {
    resetAssetsCache(char.additionalAssets ?? [], char.emotionImages ?? [], getModuleAssets(), char.chaId)
}

$effect.root(() => {
    $effect(() => {
        // Store exports are unset while Vitest is still evaluating stores.svelte, which imports this module.
        if (!selIdState) return
        const char = DBState.db.characters?.[selIdState.selId]
        if (char?.type === 'character') resetCharacterAssetsCache(char)
    })
})

function ensureAssetsCache(char: simpleCharacterArgument|character): AssetPaths {
    if (!assetsCache || assetsCacheCharacterId !== char.chaId) resetCharacterAssetsCache(char)
    return assetsCache!
}

// src holds an asset name, not a URL; an optional closing tag is swallowed too.
const assetPromptTagRegex = /<assets\s+src\s*=\s*["']([^"']*)["'][^>]*>(?:\s*<\/assets>)?/gi
// Marks a resolved asset-prompt tag inside {{img::}} so it keeps the asset style.
const assetPromptMarker = '\uE9b5'
const assetPromptExtensionRegex = new RegExp(`\\.(?:${imageAssetExtensions.join('|')})$`, 'i')

// NFKC because default names are file names (NFD Hangul from macOS) and models
// swap full-width and half-width punctuation.
function normalizeAssetPromptName(name: string): string {
    return name.normalize('NFKC').toLocaleLowerCase().replace(/[\s_-]/g, '').replace(assetPromptExtensionRegex, '')
}

function assetPromptKeys(char: simpleCharacterArgument|character) {
    const names = new Map<string, string>()
    for(const key of Object.keys(ensureAssetsCache(char))){
        const normalized = normalizeAssetPromptName(key)
        if(!names.has(normalized)) names.set(normalized, key)
    }
    return names
}

// Unlike {{img::}}, an unknown asset-prompt name draws nothing instead of a missing-image notice.
function resolveAssetPromptTags(data: string, char: simpleCharacterArgument|character) {
    if(!/<assets\s/i.test(data)){
        return data
    }
    const names = assetPromptKeys(char)
    return data.replace(assetPromptTagRegex, (_full, name: string) => {
        const key = names.get(normalizeAssetPromptName(name))
        return key ? `{{img::${assetPromptMarker}${key}}}` : ''
    })
}

export async function resolveBareAssetSrc(name: string, char: simpleCharacterArgument|character): Promise<string|null> {
    const assetPaths = ensureAssetsCache(char)
    const key = assetPromptKeys(char).get(normalizeAssetPromptName(name))
    const match = key ? assetPaths[key] : getClosestMatch(char, name.toLocaleLowerCase(), assetPaths)
    return match ? getFileSrcCached(match.srcPaths[0]) : null
}

const imageCBS = ['img', 'image', 'emotion', 'asset', 'bg', 'raw', 'path', 'source']
const videoExtensions = ['mp4', 'webm', 'avi', 'm4p', 'm4v']

async function parseAdditionalAssets(data:string, char:simpleCharacterArgument|character, mode:'normal'|'back', arg:{ch:number, showImages?:boolean}){
    const hideImages = DBState.db.hideAllImages && !arg.showImages
    const assetWidthString = (DBState.db.assetWidth && DBState.db.assetWidth !== -1 || DBState.db.assetWidth === 0) ? `max-width:${DBState.db.assetWidth}rem;` : ''

    const assetPaths = ensureAssetsCache(char)

    let needsSourceAccess = false
    let cx: number|null = null

    data = await replaceAsync(data, assetRegex, async (full:string, type:string, name:string) => {
        const fromAssetPrompt = name.startsWith(assetPromptMarker)
        if(fromAssetPrompt) name = name.slice(assetPromptMarker.length)
        const displayName = name.trim()
        name = name.toLocaleLowerCase()
        const assetNotice = (kind: ImageNoticeKind, detail = '') => {
            const html = imageNoticeHtml(kind, detail, assetWidthString)
            return type === 'image' ? `<div class="risu-inlay-image">${html}</div>\n` : html
        }

        // raw, path and source are bare urls that end up in src attributes or CSS url()s
        if(hideImages && imageCBS.includes(type)){
            // Backgrounds drop hidden assets instead of covering the screen with placeholders.
            if(mode === 'back'){
                return ''
            }
            switch(type){
                case 'raw':
                case 'path':
                case 'source':
                    return hiddenImageSrc
                case 'bg':
                    return ''
                default:
                    return assetNotice('hidden')
            }
        }

        if(type === 'source'){
            needsSourceAccess = true
            switch(name){
                case 'char':{
                    return '\uE9b4CHAR\uE9b4'
                }
                case 'user': {
                    return '\uE9b4USER\uE9b4'
                }
            }
        }

        let match = assetPaths[name]

        if(!match){
            match = getClosestMatch(char, name, assetPaths)

            if(!match){
                // Only chat messages show what went missing; elsewhere the asset stays silent.
                if(mode === 'normal' && (type === 'img' || type === 'image' || type === 'emotion')){
                    return assetNotice('missingImage', displayName)
                }
                return ''
            }
        }

        let pSrc = match.srcPaths[0]

        if(match.srcPaths.length > 1){
            if(cx === null){
                const chatID = arg.ch
                cx = pickHashRand(chatID, (char.chaId || 'global') + chatID)
            }
            const selIndex = Math.floor(cx * match.srcPaths.length)
            pSrc = match.srcPaths[selIndex]
        }

        const p = await getFileSrcCached(pSrc)
        switch(type){
            case 'raw':
            case 'path':
                return p
            case 'img':
            case 'emotion':
                if(fromAssetPrompt){
                    const dynamic = char.prebuiltAssetStyle === 'dynamic' ? ' x-risu-asset-prompt-image-dynamic' : ''
                    return `<img class="x-risu-asset-prompt-image${dynamic}" src="${p}" alt="${p}" style="${assetWidthString} "/>`
                }
                return `<img src="${p}" alt="${p}" style="${assetWidthString} "/>`
            case 'image':
                return `<div class="risu-inlay-image"><img src="${p}" alt="${p}" style="${assetWidthString}"/></div>\n`
            case 'video':
                return `<video controls autoplay loop><source src="${p}" type="video/mp4"></video>\n`
            case 'video-img':
                return `<video autoplay muted loop><source src="${p}" type="video/mp4"></video>\n`
            case 'audio':
            case 'bgm': {
                const audioSrc = md.utils.escapeHtml(p)
                const audioTitle = md.utils.escapeHtml(displayName || 'Audio')
                const characterName = md.utils.escapeHtml(char.name ?? '')
                return `<div class="risu-audio-player-slot" data-risu-audio-player="1" data-audio-src="${audioSrc}" data-audio-title="${audioTitle}" data-character-name="${characterName}"></div>\n`
            }
            case 'bg':
                if(mode === 'back'){
                    return `<div style="width:100%;height:100%;background: url(${p}); background-size: cover;"></div>`
                }
                break
            case 'asset':{
                if(match.ext && videoExtensions.includes(match.ext)){
                    return `<video autoplay muted loop><source src="${p}" type="video/mp4"></video>\n`
                }
                return `<img src="${p}" alt="${p}" style="${assetWidthString} "/>\n`
            }
        }
        return ''
    })

    if(needsSourceAccess){
        const chara = getCurrentCharacter()
        data = data.replace(/\uE9b4CHAR\uE9b4/g,
            chara.image ? (await getFileSrc(chara.image)) : ''
        )

        data = data.replace(/\uE9b4USER\uE9b4/g,
            getUserIcon() ? (await getFileSrc(getUserIcon())) : ''
        )
    }
    
    return data
}

function getClosestMatch(char: simpleCharacterArgument|character, name:string, assetPaths:AssetPaths){   
    if(!char.additionalAssets) return null

    let closest = ''
    let closestDist = 999999
    let targetPath = ''
    let targetExt = ''

    const trimmedName = trimmer(name)
    for(const asset of char.additionalAssets) {
        const key = asset[0].toLocaleLowerCase()
        const dist = getDistance(trimmedName, trimmer(key))
        if(dist < closestDist){
            closest = key
            closestDist = dist
            targetPath = asset[1]
            targetExt = asset[2]
        }
    }
    
    if(closestDist > DBState.db.assetMaxDifference){
        return null
    }

    assetPaths[closest] = {
        srcPaths: [targetPath],
        ext: targetExt
    }

    return assetPaths[closest]
}

function getDistance(a:string, b:string) {
    const h = a.length + 1
    const w = b.length + 1
    let d = new Int16Array(h * w)
    for(let i=0;i<h;i++){
        d[i * w] = i
    }
    for(let i=0;i<w;i++){
        d[i] = i
    }
    for(let i=1; i<h; i++){
        for(let j=1;j<w;j++){
            d[i * w + j] = Math.min(
                d[(i-1) * w + j-1] + (a.charAt(i-1)===b.charAt(j-1) ? 0 : 1),
                d[(i-1) * w + j]+1, d[i * w + j-1]+1
            )
        }
    }
    return d[h * w - 1]
}

function trimmer(str:string){
    const ext = ['webp', 'png', 'jpg', 'jpeg', 'gif', 'mp4', 'webm', 'avi', 'm4p', 'm4v', 'mp3', 'wav', 'ogg']
    for(const e of ext){
        if(str.endsWith('.' + e)){
            str = str.substring(0, str.length - e.length - 1)
        }
    }

    return str.trim().replace(/[_ -.]/g, '')
}

type CachedInlayAsset = {
    url: string
    type: InlayAsset['type']
    dimensions?: { width: number; height: number }
}

const blobUrlCache = new Map<string, CachedInlayAsset>()
type CachedImagePreload = {
    promise: Promise<void>
    settled: boolean
}
type RetainedImagePreload = {
    image: HTMLImageElement
    promise: Promise<void>
    cancelLoad: () => void
}
type QueuedImageDecode = {
    image: HTMLImageElement
    resolve: () => void
    reject: () => void
}
const imagePreloadCache = new Map<string, CachedImagePreload>()
const retainedImagePreloads = new Map<string, RetainedImagePreload>()
const priorityImageDecodeQueue: QueuedImageDecode[] = []
const imageDecodeQueue: QueuedImageDecode[] = []
let imageDecodeRunning = false
const INLAY_ID_ATTRIBUTE = 'data-inlay-id'
const CHAT_IMAGE_PRELOAD_TIMEOUT_MS = 10_000
const IMAGE_PRELOAD_CACHE_MAX = 512
const IMAGE_DECODE_QUEUE_MAX = 10
const RETAINED_IMAGE_MAX = 10

export function isChatImagePreloadingEnabled(): boolean {
    return DBState.db.preloadChatImages !== false && !DBState.db.hideAllImages
}

function trimImagePreloadCache() {
    if (imagePreloadCache.size <= IMAGE_PRELOAD_CACHE_MAX) return
    for (const [url, entry] of imagePreloadCache) {
        if (!entry.settled) continue
        imagePreloadCache.delete(url)
        if (imagePreloadCache.size <= IMAGE_PRELOAD_CACHE_MAX) break
    }
}

async function drainImageDecodeQueue() {
    if (imageDecodeRunning) return
    imageDecodeRunning = true
    let task: QueuedImageDecode | undefined
    while ((task = priorityImageDecodeQueue.shift() ?? imageDecodeQueue.shift())) {
        try {
            const image = task.image
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(reject, CHAT_IMAGE_PRELOAD_TIMEOUT_MS)
                image.decode().then(() => {
                    clearTimeout(timeout)
                    resolve()
                }, () => {
                    clearTimeout(timeout)
                    reject()
                })
            })
            task.resolve()
        }
        catch {
            task.reject()
        }
    }
    imageDecodeRunning = false
}

function queueImageDecode(image: HTMLImageElement, priority: boolean): Promise<void> | null {
    if (typeof image.decode !== 'function') return null
    if (priorityImageDecodeQueue.length + imageDecodeQueue.length >= IMAGE_DECODE_QUEUE_MAX) {
        if (!priority) return null
        const displaced = imageDecodeQueue.pop()
        if (!displaced) return null
        displaced.reject()
    }
    const promise = new Promise<void>((resolve, reject) => {
        const task = { image, resolve, reject: () => reject() }
        if (priority) priorityImageDecodeQueue.push(task)
        else imageDecodeQueue.push(task)
    })
    void drainImageDecodeQueue()
    return promise
}

function cancelQueuedImageDecode(image: HTMLImageElement) {
    for (const queue of [priorityImageDecodeQueue, imageDecodeQueue]) {
        for (let index = queue.length - 1; index >= 0; index--) {
            if (queue[index].image !== image) continue
            queue.splice(index, 1)[0].reject()
        }
    }
}

function loadImageElement(
    image: HTMLImageElement,
    url: string,
    prioritizeDecode = false,
    setCancel?: (cancel: () => void) => void,
): Promise<void> {
    return new Promise<void>((resolve) => {
        let settled = false
        const finish = () => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            image.onload = null
            image.onerror = null
            resolve()
        }
        const timeout = setTimeout(finish, CHAT_IMAGE_PRELOAD_TIMEOUT_MS)
        setCancel?.(finish)
        image.onload = finish
        image.onerror = finish
        image.src = url
        const decode = queueImageDecode(image, prioritizeDecode)
        if (decode) void decode.then(finish, () => {})
    })
}

function preloadImageUrl(url: string): Promise<void> {
    const normalizedUrl = url.trim()
    if (!normalizedUrl) return Promise.resolve()

    const cached = imagePreloadCache.get(normalizedUrl)
    if (cached) {
        imagePreloadCache.delete(normalizedUrl)
        imagePreloadCache.set(normalizedUrl, cached)
        return cached.promise
    }

    const promise = loadImageElement(new Image(), normalizedUrl)
    const entry: CachedImagePreload = { promise, settled: false }
    imagePreloadCache.set(normalizedUrl, entry)
    void entry.promise.then(() => {
        entry.settled = true
        trimImagePreloadCache()
    })
    trimImagePreloadCache()
    return entry.promise
}

function disposeRetainedImage(url: string, entry: RetainedImagePreload) {
    retainedImagePreloads.delete(url)
    entry.cancelLoad()
    cancelQueuedImageDecode(entry.image)
    entry.image.removeAttribute('src')
}

function trimRetainedImagePreloads() {
    while (retainedImagePreloads.size > RETAINED_IMAGE_MAX) {
        const oldest = retainedImagePreloads.entries().next().value!
        disposeRetainedImage(oldest[0], oldest[1])
    }
}

function clearRetainedImagePreloads() {
    for (const [url, entry] of retainedImagePreloads) disposeRetainedImage(url, entry)
}

function retainImageUrl(url: string): Promise<void> {
    const normalizedUrl = url.trim()
    if (!normalizedUrl) return Promise.resolve()

    let entry = retainedImagePreloads.get(normalizedUrl)
    if (!entry) {
        const image = new Image()
        let cancelLoad = () => {}
        entry = {
            image,
            promise: loadImageElement(
                image,
                normalizedUrl,
                true,
                cancel => cancelLoad = cancel,
            ),
            cancelLoad: () => cancelLoad(),
        }
        retainedImagePreloads.set(normalizedUrl, entry)
    } else {
        retainedImagePreloads.delete(normalizedUrl)
        retainedImagePreloads.set(normalizedUrl, entry)
    }

    trimRetainedImagePreloads()
    return entry.promise
}

function getCssImageUrls(value: string): string[] {
    const urls: string[] = []
    for (const match of value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)) {
        if (match[2]) urls.push(match[2])
    }
    return urls
}

function getRenderedImageUrls(html: string): string[] {
    if (typeof document === 'undefined') return []
    const template = document.createElement('template')
    template.innerHTML = html
    const urls = new Set<string>()

    for (const image of template.content.querySelectorAll<HTMLImageElement>('img[src]')) {
        const url = image.getAttribute('src')
        if (url) urls.add(url)
    }
    for (const video of template.content.querySelectorAll<HTMLVideoElement>('video[poster]')) {
        const url = video.getAttribute('poster')
        if (url) urls.add(url)
    }
    for (const element of template.content.querySelectorAll<HTMLElement>('[style]')) {
        for (const url of getCssImageUrls(element.style.backgroundImage)) urls.add(url)
    }
    return [...urls]
}

/** Preload image URLs already resolved by the chat Markdown and asset parser. */
export function preloadRenderedChatImages(html: string): Promise<void> {
    if (!isChatImagePreloadingEnabled()) {
        clearRetainedImagePreloads()
        return Promise.resolve()
    }
    return Promise.all(getRenderedImageUrls(html).map(retainImageUrl)).then(() => {})
}

type ImageNoticeKind = 'hidden' | 'missingInlay' | 'missingImage'

/** Marks the "Hide All Images" link inside a hidden image notice. */
export const HIDE_ALL_IMAGES_LINK_ATTRIBUTE = 'data-risu-hide-all-images-link'
/** Set on every image notice, naming its kind. */
export const IMAGE_NOTICE_ATTRIBUTE = 'data-risu-image-notice'
const IMAGE_NOTICE_DETAIL_MAX = 160

// Notices can land between inline tags, where markdown still reads emphasis
// and quotes, so every punctuation mark is written as an entity.
function escapeNoticeText(text: string): string {
    return text.replace(/[^\p{L}\p{N} ]/gu, (char) => `&#${char.codePointAt(0)};`)
}

/**
 * A chat image that cannot be shown: a framed box with the lucide image-off
 * icon above a short note, plus the inlay id or image path when there is one.
 * It is drawn with theme variables, so it follows color scheme changes.
 */
function imageNoticeHtml(kind: ImageNoticeKind, detail = '', style = ''): string {
    let message: string
    if (kind === 'hidden') {
        const [before = '', after = ''] = language.hideAllImagesNotice.split('{{setting}}')
        const link = `<button type="button" class="x-risu-risu-image-notice-link" ${HIDE_ALL_IMAGES_LINK_ATTRIBUTE}>${escapeNoticeText(language.hideAllImages)}</button>`
        message = escapeNoticeText(before) + link + escapeNoticeText(after)
    } else {
        message = escapeNoticeText(kind === 'missingInlay' ? language.inlayGallery.inlayMissing : language.imageNotFound)
    }
    if (detail.length > IMAGE_NOTICE_DETAIL_MAX) {
        detail = detail.slice(0, IMAGE_NOTICE_DETAIL_MAX) + '\u2026'
    }
    const detailHtml = detail
        ? `<span class="x-risu-risu-image-notice-detail">${escapeNoticeText(detail)}</span>`
        : ''
    const styleAttribute = style ? ` style="${md.utils.escapeHtml(style)}"` : ''
    // The icon and caption form one body that the box centers as a whole.
    return `<span class="x-risu-risu-image-notice" ${IMAGE_NOTICE_ATTRIBUTE}="${kind}"${styleAttribute}>`
        + '<span class="x-risu-risu-image-notice-body">'
        + `<svg class="x-risu-risu-image-notice-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${hiddenImageIcon}</svg>`
        + `<span class="x-risu-risu-image-notice-caption"><span class="x-risu-risu-image-notice-text">${message}</span>${detailHtml}</span>`
        + '</span></span>'
}

function createImageNotice(kind: ImageNoticeKind, detail = ''): HTMLElement {
    const template = document.createElement('template')
    template.innerHTML = imageNoticeHtml(kind, detail)
    return template.content.firstElementChild as HTMLElement
}

function createMissingInlayPlaceholder(id: string): HTMLElement {
    const notice = createImageNotice('missingInlay', id)
    notice.setAttribute('data-missing-inlay-id', id)
    return notice
}

/**
 * Swaps a chat image that failed to load for the placeholder. A bare image
 * gets the full notice with its path; one the card sized or styled keeps its
 * box and only shows the placeholder, so the card layout holds.
 */
export function replaceBrokenChatImage(img: HTMLImageElement) {
    if (img.hasAttribute('data-risu-hidden-image') || img.closest(`[${INLAY_VIEWER_ID_ATTRIBUTE}]`)) return
    const src = img.getAttribute('src') ?? ''
    if (!src || isSpacerImage(src)) return
    const styled = ['class', 'style', 'width', 'height'].some(name => img.hasAttribute(name))
    if (!styled) {
        img.replaceWith(createImageNotice('missingImage', src))
        return
    }
    img.removeAttribute('srcset')
    img.setAttribute('data-risu-hidden-image', '')
    img.title = src
    img.src = hiddenImageDataUri(DBState.db?.colorScheme)
}

// An inlay directly before a closing tag is the last child of an element; a
// blank line there would split that element into a stray Markdown paragraph.
const closingTagAhead = /[ \t]*<\//y

export function parseInlayAssets(data:string){
    return data.replace(inlayTokenRegex, (inlay:string, _kind:string, id:string, offset:number, source:string) => {
        const escapedId = md.utils.escapeHtml(id)
        const prefix = `<div class="risu-inlay-image" ${INLAY_VIEWER_ID_ATTRIBUTE}="${escapedId}">`
        closingTagAhead.lastIndex = offset + inlay.length
        const postfix = closingTagAhead.test(source) ? '</div>' : '</div>\n\n'

        const cached = blobUrlCache.get(id)
        if(!cached){
            // Keep a minimal box for IntersectionObserver without flashing a loading surface.
            return `${prefix}<div ${INLAY_ID_ATTRIBUTE}="${escapedId}" class="risu-inlay-placeholder"></div>${postfix}`
        }

        const url = cached.url
        switch(cached.type){
            case 'image': {
                if(shouldHideImages()){
                    return `${prefix}${imageNoticeHtml('hidden')}${postfix}`
                }
                const dimensions = cached.dimensions
                const sizeAttributes = dimensions ? ` width="${dimensions.width}" height="${dimensions.height}"` : ''
                return `${prefix}<img src="${url}"${sizeAttributes} role="button" tabindex="0"/>${postfix}`
            }
            case 'video':
                return `${prefix}<video controls><source src="${url}" type="video/mp4"></video>${postfix}`
            case 'audio':
                return `${prefix}<audio controls><source src="${url}" type="audio/mpeg"></audio>${postfix}`
        }
        return inlay
    })
}

const resolveQueue: { el: HTMLElement, id: string }[] = []
let isResolvingPlaceholders = false

function fillInlayPlaceholder(el: HTMLElement, id: string, content: Node) {
    if(el.getAttribute(INLAY_ID_ATTRIBUTE) !== id) return
    el.removeAttribute(INLAY_ID_ATTRIBUTE)
    el.classList.remove('risu-inlay-placeholder', 'x-risu-risu-inlay-placeholder')
    el.replaceChildren(content)
}

async function replaceFailedInlayImage(img: HTMLImageElement, id: string, url: string) {
    if (!img.parentNode) return
    try {
        const head = await fetch(url, { method: 'HEAD' })
        const contentType = head.headers.get('content-type') || ''
        if (contentType.startsWith('video/')) {
            blobUrlCache.set(id, { url, type: 'video' })
            const video = document.createElement('video')
            video.controls = true
            const source = document.createElement('source')
            source.src = url
            source.type = contentType
            video.appendChild(source)
            img.replaceWith(video)
            return
        }
        if (contentType.startsWith('audio/')) {
            blobUrlCache.set(id, { url, type: 'audio' })
            const audio = document.createElement('audio')
            audio.controls = true
            const source = document.createElement('source')
            source.src = url
            source.type = contentType
            audio.appendChild(source)
            img.replaceWith(audio)
            return
        }
    }
    catch {}
    img.replaceWith(createMissingInlayPlaceholder(id))
}

function observeInlayImageFailure(
    img: HTMLImageElement,
    id: string,
    url: string,
): () => void {
    let handled = false
    const handleError = () => {
        if (handled) return
        handled = true
        void replaceFailedInlayImage(img, id, url)
    }
    img.addEventListener('error', handleError, { once: true })
    if (img.complete && img.naturalWidth === 0) queueMicrotask(handleError)
    return () => img.removeEventListener('error', handleError)
}

async function processInlayQueue() {
    if (isResolvingPlaceholders || resolveQueue.length === 0) return
    isResolvingPlaceholders = true

    while (resolveQueue.length > 0) {
        const batch = resolveQueue.splice(0, 20)

        await ensureInlayAssetsCached(batch.map(({ id }) => id))

        for (const { el, id } of batch) {
            try {
                if (!el.parentNode || el.getAttribute(INLAY_ID_ATTRIBUTE) !== id) continue

                const cached = blobUrlCache.get(id)!
                const { url, type } = cached

                switch (type) {
                    case 'image':
                        if (DBState.db.hideAllImages) { fillInlayPlaceholder(el, id, createImageNotice('hidden')); break }
                        const img = document.createElement('img')
                        if (cached.dimensions) {
                            img.width = cached.dimensions.width
                            img.height = cached.dimensions.height
                        }
                        img.src = url
                        img.loading = 'lazy'
                        img.decoding = 'async'
                        img.role = 'button'
                        img.tabIndex = 0
                        img.style.animation = 'risu-fade-in 0.3s ease-out'
                        // Fallback for legacy inlays without inlay_info:
                        // if <img> fails, probe Content-Type and swap to video/audio
                        observeInlayImageFailure(img, id, url)
                        fillInlayPlaceholder(el, id, img)
                        break
                    case 'video': {
                        const video = document.createElement('video')
                        video.controls = true
                        const source = document.createElement('source')
                        source.src = url
                        source.type = 'video/mp4'
                        video.appendChild(source)
                        fillInlayPlaceholder(el, id, video)
                        break
                    }
                    case 'audio': {
                        const audio = document.createElement('audio')
                        audio.controls = true
                        const source = document.createElement('source')
                        source.src = url
                        source.type = 'audio/mpeg'
                        audio.appendChild(source)
                        fillInlayPlaceholder(el, id, audio)
                        break
                    }
                }
            } catch (e) {
                console.error(`[Inlay] Failed to load ${id}`, e)
                if (el.parentNode) {
                    fillInlayPlaceholder(el, id, createMissingInlayPlaceholder(id))
                }
            }
        }
    }

    isResolvingPlaceholders = false
}

async function ensureInlayAssetsCached(ids: readonly string[]): Promise<void> {
    const unknownIds = [...new Set(ids)].filter(id => !blobUrlCache.has(id))
    if (unknownIds.length > 0) {
        try {
            const infos = await getInlayInfosBatch(unknownIds)
            for (const id of unknownIds) {
                const info = infos[id]
                const width = info?.width ?? 0
                const height = info?.height ?? 0
                // Validate once at the cache boundary. These intrinsic dimensions
                // reserve the image ratio; CSS still owns its displayed size.
                const dimensions = info?.type === 'image'
                    && Number.isSafeInteger(width) && width > 0
                    && Number.isSafeInteger(height) && height > 0
                    ? { width, height }
                    : undefined
                blobUrlCache.set(id, {
                    url: getInlayAssetUrl(id),
                    type: info?.type ?? 'image',
                    dimensions,
                })
            }
        } catch {
            for (const id of unknownIds) {
                blobUrlCache.set(id, { url: getInlayAssetUrl(id), type: 'image' })
            }
        }
    }
}

/** Warm image bytes and decode data without mounting another DOM copy. */
async function preloadInlayAssetIds(ids: readonly string[]): Promise<void> {
    if (!isChatImagePreloadingEnabled()) return
    await ensureInlayAssetsCached(ids)
    if (!isChatImagePreloadingEnabled()) return

    await Promise.all(ids.map(id => {
        const cached = blobUrlCache.get(id)!
        if (cached.type !== 'image') return Promise.resolve()
        return preloadImageUrl(cached.url)
    }))
}

/** Keep recently useful inlay decodes in the bounded image LRU. */
async function retainInlayAssetIds(ids: readonly string[]): Promise<void> {
    if (!isChatImagePreloadingEnabled()) return
    await ensureInlayAssetsCached(ids)
    if (!isChatImagePreloadingEnabled()) return

    await Promise.all(ids.map(id => {
        const cached = blobUrlCache.get(id)!
        return cached.type === 'image' ? retainImageUrl(cached.url) : Promise.resolve()
    }))
}

export function preloadInlayAssets(
    data: string | readonly string[],
    maxAssets = Number.POSITIVE_INFINITY,
): Promise<void> {
    const limit = Number.isFinite(maxAssets)
        ? Math.max(0, Math.floor(maxAssets))
        : Number.POSITIVE_INFINITY
    return preloadInlayAssetIds(getInlayIds(data).slice(0, limit))
}

function isWithinInlayPreloadRange(root: HTMLElement): boolean {
    const chatRoot = root.closest(CHAT_SCROLL_ROOT_SELECTOR) as HTMLElement | null
    const targetRect = root.getBoundingClientRect()
    const viewportRect = chatRoot?.getBoundingClientRect()
    const viewportHeight = Math.max(1, chatRoot?.clientHeight ?? globalThis.innerHeight ?? 1)
    const viewportTop = viewportRect?.top ?? 0
    const viewportBottom = viewportRect?.bottom ?? (globalThis.innerHeight ?? viewportHeight)
    const margin = viewportHeight * CHAT_VIEWPORT_MARGIN_MULTIPLIER
    return targetRect.bottom >= viewportTop - margin
        && targetRect.top <= viewportBottom + margin
}

export function preloadInlayAssetsWhenNear(
    root: HTMLElement,
    data: readonly string[],
): () => void {
    if (!isChatImagePreloadingEnabled()) {
        clearRetainedImagePreloads()
        return () => {}
    }
    const ids = getInlayIds(data)
    if (ids.length === 0) return () => {}

    const retainImages = () => {
        void retainInlayAssetIds(ids)
    }
    const stopObserving = isWithinInlayPreloadRange(root)
        ? (retainImages(), () => {})
        : observeWithinChatViewport([root], retainImages, { once: true })

    return () => {
        stopObserving()
    }
}

export function resolveInlayPlaceholders(root: HTMLElement): () => void {
    const directImageCleanups = Array.from(
        root.querySelectorAll<HTMLImageElement>(`[${INLAY_VIEWER_ID_ATTRIBUTE}] > img`),
    ).flatMap(img => {
        const id = img.closest<HTMLElement>(`[${INLAY_VIEWER_ID_ATTRIBUTE}]`)!.getAttribute(INLAY_VIEWER_ID_ATTRIBUTE)
        const url = img.getAttribute('src')
        return id && url ? [observeInlayImageFailure(img, id, url)] : []
    })
    const placeholders = Array.from(root.querySelectorAll(`[${INLAY_ID_ATTRIBUTE}]`)) as HTMLElement[]
    const stopObserving = placeholders.length > 0
        ? observeWithinChatViewport(placeholders, target => {
            const el = target as HTMLElement
            const id = el.getAttribute(INLAY_ID_ATTRIBUTE)
            if (!id) return
            resolveQueue.push({ el, id })
            void processInlayQueue()
        })
        : () => {}

    return () => {
        stopObserving()
        for (const cleanup of directImageCleanups) cleanup()
    }
}

export interface simpleCharacterArgument{
    type: 'simple'
    additionalAssets?: [string, string, string][]
    customscript: customscript[]
    chaId: string,
    name?: string,
    emotionImages?: [string, string][]
    triggerscript?: triggerscript[]
    prebuiltAssetStyle?: string
}

function parseThoughtsAndTools(data:string, inlineThoughts = false){
    let result = '', i = 0
    const renderInlineThoughts = (thoughts:string) =>
        `<div class="x-risu-streaming-thoughts"><div><strong>${language.cot}</strong></div>${thoughts}</div>`
    while (i < data.length) {
        if (data.slice(i, i + 10) === '<Thoughts>') {
            let j = i + 10, depth = 1
            while (j < data.length && depth > 0) {
                if (data.slice(j, j + 10) === '<Thoughts>') depth++
                if (data.slice(j, j + 11) === '</Thoughts>') depth--
                j++
            }
            if (depth === 0) {
                const thoughts = data.substring(i + 10, j - 1)
                result += inlineThoughts
                    ? renderInlineThoughts(thoughts)
                    : `<details class="x-risu-thoughts"><summary>${language.cot}</summary>${thoughts}</details>`
                i = j + 10
                continue
            }
            if (inlineThoughts) {
                result += renderInlineThoughts(data.substring(i + 10))
                break
            }
        }
        result += data[i++]
    }
    return result.replace(/<tool_call>(.+?)<\/tool_call>/gms, (full, txt:string) => {
        return `<div class="x-risu-tool-call">🛠️ ${language.toolCalled.replace('{{tool}}',txt.split('\uf100')[1] ?? 'unknown')}</div>\n\n`
    })
}

export async function prepareMarkdownSource(
    data:string,
    charArg:(character|simpleCharacterArgument | string) = null,
    mode:'normal'|'back'|'pretranslate'|'notrim' = 'normal',
    chatID=-1,
    cbsConditions:CbsConditions = {},
    options:{inlineThoughts?:boolean} = {},
) {
    const additionalAssetMode = (mode === 'back') ? 'back' : 'normal'
    const char = (typeof(charArg) === 'string') ? (findCharacterbyId(charArg)) : (charArg)

    if(char){
        data = await parseAdditionalAssets(data, char, additionalAssetMode, {
            ch: chatID
        })
        const firstParsed = data
        data = (await processScriptFull(char, data, 'editdisplay', chatID, cbsConditions)).data
        // After display regex, so a bot's own regex can still rewrite asset tags first.
        data = resolveAssetPromptTags(data, char)
        if(firstParsed !== data){
            data = await parseAdditionalAssets(data, char, additionalAssetMode, {
                ch: chatID
            })
        }
    }

    data = parseInlayAssets(data ?? '')
    data = parseThoughtsAndTools(data, options.inlineThoughts === true)
    return encodeStyle(data)
}

export async function renderPreparedMarkdown(
    data:string,
    mode:'normal'|'back'|'pretranslate'|'notrim' = 'normal',
) {
    if(mode === 'normal' || mode === 'notrim'){
        data = await renderHighlightableMarkdown(data)

        if(mode === 'notrim'){
            return data
        }
    }
    return trimMarkdown(data)
}

export async function ParseMarkdown(
    data:string,
    charArg:(character|simpleCharacterArgument | string) = null,
    mode:'normal'|'back'|'pretranslate'|'notrim' = 'normal',
    chatID=-1,
    cbsConditions:CbsConditions = {},
    options:{inlineThoughts?:boolean} = {},
) {
    return renderPreparedMarkdown(
        await prepareMarkdownSource(data, charArg, mode, chatID, cbsConditions, options),
        mode,
    )
}

const trimPurifyConfig = {
    ADD_TAGS: ["iframe", "style", "risu-style", "x-em", 'annotation', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'msqrt'],
    ADD_ATTR: ["allow", "allowfullscreen", "frameborder", "scrolling", "open", "risu-btn", 'risu-form', 'risu-trigger', 'risu-mark', 'risu-id', 'x-hl-text', INLAY_ID_ATTRIBUTE],
}

const trimCache = new Map<string, string>()
const TRIM_CACHE_MAX = 200

export function trimMarkdown(data:string){
    if (!data) return ''
    const cacheKey = `${DBState.db?.hideAllImages ? '1' : '0'}|${DBState.db?.returnCSSError ? '1' : '0'}|${data}`
    let cached = trimCache.get(cacheKey)
    if (cached === undefined) {
        cached = trimMarkdownUncached(data)
        if (trimCache.size >= TRIM_CACHE_MAX) {
            trimCache.delete(trimCache.keys().next().value!)
        }
        trimCache.set(cacheKey, cached)
    }
    // Themed after the cache so a color scheme change redraws placeholders
    // without keying the cache on the scheme.
    return applyHiddenImageTheme(cached, DBState.db?.colorScheme)
}

// Onboarding HTML can bind clicks and inputs to chat variables, so it gets the
// regular message config plus the two binding attributes. Messages never do.
const onboardingPurifyConfig = {
    ...trimPurifyConfig,
    ADD_ATTR: [...trimPurifyConfig.ADD_ATTR, 'risu-change-var-name', 'risu-change-var-value'],
}

/**
 * Renders a character's onboarding HTML with the chat message asset, CBS,
 * sanitizer and `<style>` scoping. Scoped styles are prefixed with
 * `.chattext`, so the caller renders the result inside a `.chattext` element.
 * The trim cache is bypassed so the wider config never serves a message.
 * Images show even under hideAllImages.
 */
export async function parseOnboardingHTML(data:string, char:character){
    data = await parseAdditionalAssets(data ?? '', char, 'normal', { ch: -1, showImages: true })
    showImagesForOnboarding = true
    try {
        data = parseInlayAssets(risuChatParser(data, { chara: char }))
        return data ? trimMarkdownUncached(encodeStyle(data), onboardingPurifyConfig) : ''
    } finally {
        showImagesForOnboarding = false
    }
}

function trimMarkdownUncached(data:string, purifyConfig:typeof trimPurifyConfig = trimPurifyConfig){
    // Most messages contain no custom styles. Keep that hot path to one
    // string-returning sanitize call and avoid constructing a DOM.
    if(!data.includes('<risu-style')){
        return DOMPurify.sanitize(data, purifyConfig)
    }

    // Parse first so only real elements become placeholders; markup-looking
    // text inside attributes remains inert. The placeholders go through the
    // single sanitizer pass, while decoded CSS never re-enters an HTML parser.
    const sourceRoot = new DOMParser().parseFromString(data, 'text/html').body
    const styleElements = Array.from(sourceRoot.querySelectorAll('risu-style'))
    const indexWidth = Math.max(1, `${styleElements.length - 1}`.length)
    // DOMPurify 3.4 drops generic XML-like text markers under SAFE_FOR_XML.
    // Use a numeric nonce absent from the source and a distinct numeric tail.
    let markerPrefix = '9'.repeat(32)
    while(data.includes(markerPrefix)) markerPrefix += '9'
    const markerSuffix = '8'.repeat(markerPrefix.length)
    const markerRegex = new RegExp(`(?:<span>)?${markerPrefix}(\\d{${indexWidth}})${markerSuffix}(?:</span>)?`, 'g')

    const replacements:ReturnType<typeof decodeStyleContent>[] = []
    for(const element of styleElements){
        replacements.push(decodeStyleContent(element.textContent ?? ''))
        // A temporary inline element keeps a leading marker from being
        // discarded by DOMPurify without changing the surrounding flow.
        const placeholder = sourceRoot.ownerDocument.createElement('span')
        placeholder.textContent = `${markerPrefix}${(replacements.length - 1).toString().padStart(indexWidth, '0')}${markerSuffix}`
        element.replaceWith(placeholder)
    }

    const sanitized = DOMPurify.sanitize(sourceRoot.innerHTML, purifyConfig)
    return sanitized
        .replace(markerRegex, (_marker, index:string) => {
            const decoded = replacements[Number(index)]
            if(decoded?.css === undefined){
                return md.utils.escapeHtml(decoded?.fallback ?? '')
            }
            // A literal closing style tag is the only raw-text sequence that
            // can escape the element when this HTML is mounted again.
            return `<style>${decoded.css.replaceAll(/<\/(?=style)/gi, '<\\/')}</style>`
        })
}

const metaCodes = [
    '\u200B', //zero width space
    '\u200C', //zero width non-joiner
    '\u200D', //zero width joiner
    '\uFEFF', //zero width no-break space
    '\u2060', //word joiner
    '\u180E', //mongolian vowel separator
]

const encodedMetadataCache = new Map<string, string>()

function encodeMetadata(modelShortName:string){
    const metadata = '{' + [
        'risuai',
        modelShortName.toLocaleLowerCase().replace(/[^a-z]/g, ''),
    ].join('|') + '}'

    const cached = encodedMetadataCache.get(metadata)
    if(cached !== undefined){
        return cached
    }

    let encodedMetaCode = ''
    for(let i=0;i<metadata.length;i++){
        let byte = (metadata.charCodeAt(i) - 97).toString(6).padStart(2,'0')
        for(let j=0;j<byte.length;j++){
            switch(byte.charAt(j)){
                case '0':{
                    encodedMetaCode += metaCodes[0]
                    break
                }
                case '1':{
                    encodedMetaCode += metaCodes[1]
                    break
                }
                case '2':{
                    encodedMetaCode += metaCodes[2]
                    break
                }
                case '3':{
                    encodedMetaCode += metaCodes[3]
                    break
                }
                case '4':{
                    encodedMetaCode += metaCodes[4]
                    break
                }
                case '5':{
                    encodedMetaCode += metaCodes[5]
                    break
                }
            }
        }
    }

    encodedMetadataCache.set(metadata, encodedMetaCode)
    return encodedMetaCode
}

export function addMetadataToElement(
    data:string,
    modelShortName:string,
    appendTerminalMetadata = true,
){
    if(!aiWatermarkingLawApplies()){
        return data
    }

    const encodedMetaCode = encodeMetadata(modelShortName)

    let d =  data.replace(/\<p\>/g, (v) => {
        return '<p>' + encodedMetaCode
    })

    return d + (appendTerminalMetadata ? encodedMetaCode : '')
}

export async function postTranslationParse(data:string){
    let lines = data.split('\n')

    for(let i=0;i<lines.length;i++){
        const trimed = lines[i].trim()
        if(trimed.startsWith('<')){
            lines[i] = trimed
        }
    }

    data = await renderHighlightableMarkdown(lines.join('\n'))
    return data
}

export function parseMarkdownSafe(data:string, arg:{
    forbidTags?: string[],
} = {}) {
    return DOMPurify.sanitize(renderMarkdown(md, data), {
        FORBID_TAGS: ["a", "style", ...(arg.forbidTags || [])],
        FORBID_ATTR: ["style", "href", "class"]
    })
}


const styleRegex = /\<style\>(.+?)\<\/style\>/gms
function encodeStyle(txt:string){
    return txt.replaceAll(styleRegex, (f, c1) => {
        return "<risu-style>" + Buffer.from(c1).toString('hex') + "</risu-style>"
    })
}
function decodeStyleRule<T extends CssAtRuleAST | CssDeclarationAST>(rule:T): T {
    if(rule.type === 'rule'){
        for(let i=0;i<rule.selectors.length;i++){
            let slt:string = rule.selectors[i]
            if(slt){

                const parser = cssSelectorParser((root) => {
                    root.walkClasses((classes) => {
                        if(!classes.value.startsWith('x-risu-')){
                            classes.value = 'x-risu-' + classes.value
                        }
                    })
                })

                slt = parser.processSync(slt)

                rule.selectors[i] = ".chattext " + slt
            }
        }
    }
    if(rule.type === 'media' || rule.type === 'supports' || rule.type === 'document' || rule.type === 'host' || rule.type === 'container' ){
        for(let i=0;i<rule.rules.length;i++){
            rule.rules[i] = decodeStyleRule(rule.rules[i])
        }
    }
    if(rule.type === 'import'){
       if(rule.import.startsWith('data:')){
            rule.import = 'data:,'
       }
    }
    return rule
}

function decodeStyleContent(hexText:string):{css?:string, fallback?:string}{
    try {
        let text = Buffer.from(hexText, 'hex').toString('utf-8')
        text = risuChatParser(text)
        const ast = css.parse(text)
        const rules = ast.stylesheet.rules
        for(let i=0;i<rules.length;i++){
            rules[i] = decodeStyleRule(rules[i])
            if(shouldHideImages()){
                hideStyleRuleImages(rules[i])
            }
        }
        return {
            css: css.stringify(ast, {
                indent: '',
                compress: true,
            }),
        }
    } catch (error) {
        return {
            fallback: DBState.db.returnCSSError ? `CSS ERROR: ${error}` : '',
        }
    }
}

export { sha256Hex as hasher } from '../hash'

export type { CbsConditions } from './cbsCore'

let matcherInitialized = false


const matcherMap = new Map<string, RegisterCallback>()

function initMatcher(){
    if(matcherInitialized) return
    registerCBS({
        registerFunction: function (arg: {
            name: string;
            callback: RegisterCallback | 'doc_only';
            alias: string[];
            description: string;
            deprecated?: { message: string; since?: string; replacement?: string; };
            internalOnly?: boolean;
        }): void | Promise<void> {
            const callback = arg.callback
            if(callback === 'doc_only') {
                return
            }
            const names = [arg.name, ...arg.alias]
            for (const name of names) {
                matcherMap.set(name, callback)
            }
        },
        getDatabase: getDatabase,
        getChatPage,
        getUserName: getUserName,
        getTriggerId: () => get(CurrentTriggerIdStore),
        getPersonaPrompt: getPersonaPrompt,
        risuChatParser: risuChatParser,
        makeArray: makeArray,
        structuredClone: structuredClone,
        parseArray: parseArray,
        parseDict: parseDict,
        getChatVar: getChatVar,
        setChatVar: setChatVar,
        getGlobalChatVar: getGlobalChatVar,
        calcString: calcString,
        dateTimeFormat: dateTimeFormat,
        getModules: getModules,
        getModuleLorebooks: getModuleLorebooks,
        pickHashRand: pickHashRand,
        getSelectedCharID: () => {
            return get(selectedCharID)
        },
        getGenerationModelString: getGenerationModelString,
        getGenerationModelMetadata: getGenerationModelMetadata,
        callInternalFunction: function (args: string[]): string {
            return ''
        },
        isNodeServer: isNodeServer,
        isMobile: false,
        pocketKeiVer: pocketKeiVer,
    })
    matcherInitialized = true
}

const browserCbsEnv: CbsParserEnv = {
    matchers: matcherMap,
    ensureMatchers: initMatcher,
    calcString,
    getChatVar,
    getGlobalChatVar,
    getDatabase: () => DBState.db,
    getSelectedCharacter: db => db.characters[get(selectedCharID)],
}

export function risuChatParser(da:string, arg:CbsParserArg = {}):string{
    return parseCbs(da, arg, browserCbsEnv)
}

export function applyMarkdownToNode(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent;
        if (text) {
            let markdown = renderMarkdown(md, text);
            if (markdown !== text) {
                const span = document.createElement('span');
                span.innerHTML = markdown;
                
                const parentStyle = (node.parentNode as HTMLElement)?.style;
                if(parentStyle){
                    for(let i=0;i<parentStyle.length;i++){
                        span.style.setProperty(parentStyle[i], parentStyle.getPropertyValue(parentStyle[i]))
                    }   
                }
                (node as Text).replaceWith(span);
                return
            }
        }
    } else {
        for (const child of node.childNodes) {
            applyMarkdownToNode(child);
        }
    }
}
