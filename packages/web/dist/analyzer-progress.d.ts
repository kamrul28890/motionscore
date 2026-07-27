export interface AnalyzerProgressEvent {
    stage: string;
    message: string;
    percent: number;
}
/**
 * Parse the line-oriented JSON progress protocol emitted by extract_stems.py.
 * Invalid or unrelated stderr stays diagnostic text and must never break a job.
 */
export declare function parseAnalyzerProgressLine(line: string): AnalyzerProgressEvent | null;
//# sourceMappingURL=analyzer-progress.d.ts.map