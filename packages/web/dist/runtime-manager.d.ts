export type RuntimeMode = 'cpu' | 'cuda';
export type RuntimeState = 'ready' | 'missing' | 'installing' | 'error';
export interface RuntimeStatus {
    state: RuntimeState;
    ready: boolean;
    managed: boolean;
    mode: RuntimeMode | null;
    pythonPath: string | null;
    pythonVersion: string | null;
    torchVersion: string | null;
    ffmpegReady: boolean;
    nvidiaAvailable: boolean;
    runtimeRoot: string;
    error?: string;
}
export interface RuntimeProgress {
    stage: string;
    message: string;
    percent: number;
    status?: 'complete' | 'error';
}
export declare class RuntimeManager {
    readonly runtimeRoot: string;
    readonly pythonRoot: string;
    readonly managedPython: string;
    readonly binDir: string;
    readonly ffmpegPath: string;
    readonly markerPath: string;
    private installing;
    private latestError;
    private events;
    private listeners;
    constructor(projectRoot: string);
    get progress(): readonly RuntimeProgress[];
    subscribe(listener: (event: RuntimeProgress) => void): () => void;
    private emit;
    private candidatePython;
    private applyEnvironment;
    private probe;
    inspect(): Promise<RuntimeStatus>;
    private download;
    install(mode: RuntimeMode): Promise<void>;
    readMarker(): unknown;
}
//# sourceMappingURL=runtime-manager.d.ts.map