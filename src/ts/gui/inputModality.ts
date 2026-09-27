type InputModality = 'keyboard' | 'pointer'

const modalityByDocument = new WeakMap<Document, InputModality>()
const trackedDocuments = new WeakSet<Document>()

function trackDocument(doc: Document): void {
    if (trackedDocuments.has(doc)) return
    trackedDocuments.add(doc)
    modalityByDocument.set(doc, 'pointer')
    doc.addEventListener('pointerdown', () => {
        modalityByDocument.set(doc, 'pointer')
    }, true)
    doc.addEventListener('keydown', () => {
        modalityByDocument.set(doc, 'keyboard')
    }, true)
}

if (typeof document !== 'undefined') trackDocument(document)

export function wasLastInteractionKeyboard(doc: Document = document): boolean {
    trackDocument(doc)
    return modalityByDocument.get(doc) === 'keyboard'
}
