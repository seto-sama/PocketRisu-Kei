import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping';

// Timeout for fetch requests (10 seconds)
const FETCH_TIMEOUT_MS = 10000;

export interface StackTraceTranslationResult {
    stackTrace: string;
    didTranslate: boolean;
}

export async function translateStackTrace(stackTrace: string): Promise<StackTraceTranslationResult> {
    if (!stackTrace) {
        return {
            stackTrace: '',
            didTranslate: false
        };
    }

    const stackLines = stackTrace.split('\n');

    // Cache parsed maps to avoid fetching/parsing the same file multiple times.
    const consumerCache = new Map<string, TraceMap>();

    // Step 1: Collect all unique mapUrls from stack trace
    const urlsToFetch = new Set<string>();
    const linePattern = /(http[s]?:\/\/[^\s)]+\.js):(\d+):(\d+)/;
    
    for (const line of stackLines) {
        const match = line.match(linePattern);
        if (match) {
            const mapUrl = match[1] + '.map';
            urlsToFetch.add(mapUrl);
        }
    }

    if (urlsToFetch.size === 0) {
        return {
            stackTrace,
            didTranslate: false
        };
    }

    // Step 2: Fetch all sourcemaps in parallel
    await Promise.all(
        Array.from(urlsToFetch).map(async (mapUrl) => {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

                try {
                    const mapRes = await fetch(mapUrl, { 
                        method: 'GET',
                        signal: controller.signal
                    });
                    
                    clearTimeout(timeoutId);
                    
                    if (mapRes.ok) {
                        try {
                            const mapContent = await mapRes.json();
                            const consumer = new TraceMap(mapContent);
                            consumerCache.set(mapUrl, consumer);
                        } catch (parseError) {
                            const errorMsg = `Failed to parse sourcemap: ${getFileName(mapUrl)}`;
                            console.error(errorMsg, parseError);
                        }
                    } else {
                        const errorMsg = `Sourcemap not found: ${getFileName(mapUrl)} (${mapRes.status} ${mapRes.statusText})`;
                        console.error(errorMsg);
                    }
                } catch (fetchError) {
                    clearTimeout(timeoutId);
                    
                    if (fetchError instanceof Error && fetchError.name === 'AbortError') {
                        const errorMsg = `Sourcemap fetch timed out: ${getFileName(mapUrl)}`;
                        console.error(errorMsg);
                    } else {
                        const errorMsg = `Failed to fetch sourcemap: ${getFileName(mapUrl)}`;
                        console.error(errorMsg, fetchError);
                    }
                }
            } catch (e) {
                const errorMsg = `Failed to fetch sourcemap: ${getFileName(mapUrl)}`;
                console.error(errorMsg, e);
            }
        })
    );

    // Step 3: Translate stack frames while maintaining order.
    let translatedFrameCount = 0;
    const processedLines = stackLines.map((line) => {
        const match = line.match(linePattern);
        if (match) {
            const [, url, lineNumber, columnNumber] = match;
            const mapUrl = url + '.map';

            const consumer = consumerCache.get(mapUrl);
            if (consumer) {
                const originalPosition = originalPositionFor(consumer, {
                    line: parseInt(lineNumber, 10),
                    column: parseInt(columnNumber, 10)
                });
                if (originalPosition.source) {
                    translatedFrameCount += 1;
                    if (originalPosition.name) {
                        return `    at ${originalPosition.name} (${originalPosition.source}:${originalPosition.line}:${originalPosition.column})`;
                    }
                    return `    at ${originalPosition.source}:${originalPosition.line}:${originalPosition.column}`;
                }
            }
        }
        return line;
    });

    if (translatedFrameCount === 0) {
        return {
            stackTrace,
            didTranslate: false
        };
    }

    return {
        stackTrace: processedLines.join('\n'),
        didTranslate: true
    };
}

// Helper function to extract filename from URL for cleaner error messages
function getFileName(url: string): string {
    try {
        const urlObj = new URL(url);
        return urlObj.pathname.split('/').pop() || url;
    } catch {
        return url;
    }
}
