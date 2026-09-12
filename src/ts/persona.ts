import { Buffer } from 'buffer'
import { getDatabase, saveImage, setDatabase } from "./storage/database.svelte"
import { selectSingleImageFile, selectSingleImportFile, sleep } from "./util"
import { alertConfirm, alertError, alertStore, notifySuccess, notifyError } from "./alert"
import { AppendableBuffer, downloadFile, requestImmediateSave } from "./globalApi.svelte"
import { language } from "src/lang"
import { reencodeImage } from "./process/files/inlays"
import { PngChunk } from "./pngChunk"
import { readAvatarImageOrDefault } from "./avatarImage"
import { appendPresetItem, movePresetItem, removePresetItem, reorderPresetSubset } from "./preset/collection"
import { createEntityId } from './id'

export async function selectUserImg() {
    const selected = await selectSingleImageFile()
    if (!selected) {
        return
    }
    const img = selected.data
    let db = getDatabase()
    const imgp = await saveImage(img)
    db.userIcon = imgp
    db.personas[db.selectedPersona] = {
        ...db.personas[db.selectedPersona],
        name: db.username,
        icon: db.userIcon,
        personaPrompt: db.personaPrompt,
        note: db.userNote,
        id: db.personas[db.selectedPersona].id ?? createEntityId()
    }
}

export function saveUserPersona() {
    let db = getDatabase()
    db.personas[db.selectedPersona].name = db.username
    db.personas[db.selectedPersona].icon = db.userIcon
    db.personas[db.selectedPersona].personaPrompt = db.personaPrompt
    db.personas[db.selectedPersona].note = db.userNote
}

export function changeUserPersona(id: number, save: 'save' | 'noSave' = 'save') {
    if (save === 'save') {
        saveUserPersona()
    }
    let db = getDatabase()
    const pr = db.personas[id]
    db.personaPrompt = pr.personaPrompt
    db.username = pr.name
    db.userIcon = pr.icon
    db.userNote = pr.note
    db.selectedPersona = id
}

export function createUserPersona() {
    const db = getDatabase()
    const result = appendPresetItem(db.personas, {
        id: createEntityId(),
        name: language.newPersona,
        icon: '',
        personaPrompt: '',
        note: '',
        tagIds: undefined,
    })
    db.personas = result.items
    changeUserPersona(result.selectedIndex)
    void requestImmediateSave()
}

export function reorderUserPersonas(orderedIndexes: number[]) {
    const db = getDatabase()
    if (orderedIndexes.length !== db.personas.length) return
    const uniqueIndexes = new Set(orderedIndexes)
    if (uniqueIndexes.size !== db.personas.length
        || orderedIndexes.some(index => !Number.isInteger(index) || index < 0 || index >= db.personas.length)) return

    saveUserPersona()
    const orderedIds = orderedIndexes.map(index => db.personas[index].id)
    const result = reorderPresetSubset(db.personas, db.selectedPersona, orderedIds)
    if (!result.changed) return
    db.personas = result.items
    changeUserPersona(result.selectedIndex, 'noSave')
    void requestImmediateSave()
}

export function moveUserPersona(fromIndex: number, toIndex: number) {
    const db = getDatabase()
    saveUserPersona()
    const result = movePresetItem(db.personas, db.selectedPersona, fromIndex, toIndex)
    if (!result.changed) return
    db.personas = result.items
    changeUserPersona(result.selectedIndex, 'noSave')
    void requestImmediateSave()
}

export async function deleteUserPersona(index: number) {
    const db = getDatabase()
    const persona = db.personas[index]
    if (!persona || db.personas.length === 1) return
    if (!await alertConfirm(`${language.removeConfirm}${persona.name}`)) return

    saveUserPersona()
    const deletingSelected = index === db.selectedPersona
    const result = removePresetItem(db.personas, db.selectedPersona, index)
    if (!result.changed) return
    db.personas = result.items
    const selectedIndex = deletingSelected ? Math.max(0, index - 1) : result.selectedIndex
    changeUserPersona(selectedIndex, 'noSave')
    void requestImmediateSave()
}

interface PersonaCard {
    name: string
    personaPrompt: string
    note?: string
}

export async function exportUserPersona(personaIndex?: number) {
    if (personaIndex !== undefined && getDatabase().selectedPersona === personaIndex) {
        saveUserPersona()
    }
    let db = getDatabase({ snapshot: true })
    const persona = personaIndex === undefined
        ? {
            name: db.username,
            personaPrompt: db.personaPrompt,
            note: db.userNote,
            icon: db.userIcon,
        }
        : db.personas[personaIndex]
    if (!persona || !persona.name || !persona.personaPrompt) {
        notifyError(language.personaExportEmpty)
        return
    }

    let img = await readAvatarImageOrDefault(persona.icon)

    let card: PersonaCard = structuredClone({
        name: persona.name,
        personaPrompt: persona.personaPrompt,
        note: persona.note,
    })

    alertStore.set({
        type: 'wait',
        msg: 'Loading... (Writing Exif)'
    })

    await sleep(10)

    img = (await PngChunk.write(await reencodeImage(img), {
        "persona": Buffer.from(JSON.stringify(card)).toString('base64')
    })) as Uint8Array

    alertStore.set({
        type: 'wait',
        msg: 'Loading... (Writing)'
    })

    await sleep(10)
    await downloadFile(`${persona.name.replace(/[<>:"/\\|?*\.\,]/g, "")}_export.png`, img)

    notifySuccess(language.successExport)
}

export async function importUserPersona() {
    try {
        const v = await selectSingleImportFile()
        if (!v) {
            return
        }
        const readGenerator = PngChunk.readGenerator(v.data)
        let decoded: string | undefined;

        for await (const chunk of readGenerator) {
            if (chunk && !(chunk instanceof AppendableBuffer) && chunk.key === 'persona') {
                decoded = chunk.value
                break
            }
        }

        if (!decoded) {
            alertError(language.errors.noData)
            return
        }
        const data: PersonaCard = JSON.parse(Buffer.from(decoded, 'base64').toString('utf-8'))
        if (data.name && data.personaPrompt) {
            let db = getDatabase()
            db.personas = appendPresetItem(db.personas, {
                name: data.name,
                icon: await saveImage(await reencodeImage(v.data)),
                personaPrompt: data.personaPrompt,
                note: data.note,
                id: createEntityId()
            }).items
            notifySuccess(language.successImport)
        } else {
            alertError(language.errors.noData)
        }
    } catch (error) {
        alertError(error)
        return
    }
}
