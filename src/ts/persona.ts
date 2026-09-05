import { getDatabase, saveImage, setDatabase } from "./storage/database.svelte"
import { selectSingleFile, sleep } from "./util"
import { alertConfirm, alertError, alertStore, notifySuccess, notifyError } from "./alert"
import { AppendableBuffer, downloadFile, requestImmediateSave } from "./globalApi.svelte"
import { language } from "src/lang"
import { reencodeImage } from "./process/files/inlays"
import { PngChunk } from "./pngChunk"
import { v4 } from "uuid"
import { readAvatarImageOrDefault } from "./avatarImage"

export async function selectUserImg() {
    const selected = await selectSingleFile(['png'])
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
        id: db.personas[db.selectedPersona].id ?? v4()
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
    db.personas = [...db.personas, {
        id: v4(),
        name: language.newPersona,
        icon: '',
        personaPrompt: '',
        note: '',
        tagIds: undefined,
    }]
    changeUserPersona(db.personas.length - 1)
    void requestImmediateSave()
}

export function reorderUserPersonas(orderedIndexes: number[]) {
    const db = getDatabase()
    if (orderedIndexes.length !== db.personas.length) return
    const uniqueIndexes = new Set(orderedIndexes)
    if (uniqueIndexes.size !== db.personas.length
        || orderedIndexes.some(index => !Number.isInteger(index) || index < 0 || index >= db.personas.length)) return

    saveUserPersona()
    const selected = db.personas[db.selectedPersona]
    db.personas = orderedIndexes.map(index => db.personas[index])
    changeUserPersona(Math.max(0, db.personas.indexOf(selected)), 'noSave')
    void requestImmediateSave()
}

export function moveUserPersona(fromIndex: number, toIndex: number) {
    const personaCount = getDatabase().personas.length
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0
        || fromIndex >= personaCount || toIndex > personaCount) return

    const orderedIndexes = Array.from({ length: personaCount }, (_, index) => index)
    const [movedIndex] = orderedIndexes.splice(fromIndex, 1)
    const adjustedToIndex = fromIndex < toIndex ? toIndex - 1 : toIndex
    orderedIndexes.splice(adjustedToIndex, 0, movedIndex)
    reorderUserPersonas(orderedIndexes)
}

export async function deleteUserPersona(index: number) {
    const db = getDatabase()
    const persona = db.personas[index]
    if (!persona || db.personas.length === 1) return
    if (!await alertConfirm(`${language.removeConfirm}${persona.name}`)) return

    saveUserPersona()
    const deletingSelected = index === db.selectedPersona
    const selected = db.personas[db.selectedPersona]
    const next = db.personas.filter((_, personaIndex) => personaIndex !== index)
    db.personas = next
    const selectedIndex = deletingSelected ? Math.max(0, index - 1) : next.indexOf(selected)
    changeUserPersona(selectedIndex >= 0 ? selectedIndex : 0, 'noSave')
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

    let card: PersonaCard = safeStructuredClone({
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
        const v = await selectSingleFile(['png'])
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
            db.personas.push({
                name: data.name,
                icon: await saveImage(await reencodeImage(v.data)),
                personaPrompt: data.personaPrompt,
                note: data.note,
                id: v4()
            })
            notifySuccess(language.successImport)
        } else {
            alertError(language.errors.noData)
        }
    } catch (error) {
        alertError(error)
        return
    }
}
