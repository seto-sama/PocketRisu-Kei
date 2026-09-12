type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P]
}

declare module 'qrcode' {
  const QRCode: {
    toDataURL(
      text: string,
      options?: {
        width?: number
        margin?: number
      },
    ): Promise<string>
  }

  export default QRCode
}

declare module 'streamsaver' {
  export function createWriteStream(filename: string): WritableStream<Uint8Array>
}
