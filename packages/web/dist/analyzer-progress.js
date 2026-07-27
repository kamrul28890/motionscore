const PROGRESS_PREFIX = '[motionscore] progress ';
/**
 * Parse the line-oriented JSON progress protocol emitted by extract_stems.py.
 * Invalid or unrelated stderr stays diagnostic text and must never break a job.
 */
export function parseAnalyzerProgressLine(line) {
    const markerIndex = line.indexOf(PROGRESS_PREFIX);
    if (markerIndex < 0)
        return null;
    try {
        const value = JSON.parse(line.slice(markerIndex + PROGRESS_PREFIX.length));
        if (typeof value !== 'object' || value === null || Array.isArray(value))
            return null;
        const record = value;
        const stage = typeof record['stage'] === 'string' ? record['stage'].trim() : '';
        const message = typeof record['message'] === 'string' ? record['message'].trim() : '';
        const percent = record['percent'];
        if (stage.length === 0 ||
            message.length === 0 ||
            typeof percent !== 'number' ||
            !Number.isInteger(percent) ||
            percent < 0 ||
            percent > 99) {
            return null;
        }
        return { stage, message, percent };
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=analyzer-progress.js.map