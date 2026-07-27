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
