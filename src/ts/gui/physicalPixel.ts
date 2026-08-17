export function getPhysicalPixelQuantum(devicePixelRatio: number) {
    return Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
        ? 1 / devicePixelRatio
        : 1
}

export function snapCssLengthToPhysicalPixel(length: number, devicePixelRatio: number) {
    const quantum = getPhysicalPixelQuantum(devicePixelRatio)
    return Math.round(length / quantum) * quantum
}
