type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P]
}

declare module 'streamsaver' {
  export function createWriteStream(filename: string): WritableStream<Uint8Array>
}
