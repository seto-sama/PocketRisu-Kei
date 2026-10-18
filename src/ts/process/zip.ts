import * as zip from '@zip.js/zip.js/lib/zip-core-custom.js'

zip.configure({ useWebWorkers: false, useCompressionStream: true })

export { zip }
