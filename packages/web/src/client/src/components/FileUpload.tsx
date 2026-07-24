import { useCallback, useRef, useState } from 'react';

const ACCEPTED_EXTENSIONS = ['.mp3', '.wav', '.flac', '.ogg'];
const ACCEPT_STRING = ACCEPTED_EXTENSIONS.map((e) => `audio/${e.slice(1)}`).join(',') + ',' + ACCEPTED_EXTENSIONS.join(',');

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function detectType(filename: string): string {
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '';
  if (['.wav', '.mp3', '.flac', '.ogg'].includes(ext)) return 'Audio';
  return 'Unknown';
}

interface FileUploadProps {
  file: File | null;
  onFileSelect: (file: File) => void;
  disabled: boolean;
}

export function FileUpload({ file, onFileSelect, disabled }: FileUploadProps) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    (f: File) => {
      const ext = f.name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '';
      if (ACCEPTED_EXTENSIONS.includes(ext)) {
        onFileSelect(f);
      }
    },
    [onFileSelect],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (disabled) return;
      const f = e.dataTransfer.files[0];
      if (f) handleFile(f);
    },
    [disabled, handleFile],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (!disabled) setIsDragging(true);
    },
    [disabled],
  );

  const handleDragLeave = useCallback(() => setIsDragging(false), []);

  const handleClick = useCallback(() => {
    if (!disabled) inputRef.current?.click();
  }, [disabled]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (f) handleFile(f);
    },
    [handleFile],
  );

  return (
    <div className="card">
      <div className="card-head">
        <h2>Input file</h2>
        {file && !disabled && <span className="card-head-hint">Click to replace</span>}
      </div>
      <div
        className={`drop-zone ${isDragging ? 'dragging' : ''} ${disabled ? 'disabled' : ''} ${file ? 'has-file' : ''}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={handleClick}
        role="button"
        tabIndex={0}
        aria-label="Upload file"
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleClick(); }}
      >
        {file ? (
          <div className="file-info">
            <span className="file-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="4" y1="12" x2="4" y2="12" />
                <line x1="8" y1="8" x2="8" y2="16" />
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="16" y1="9" x2="16" y2="15" />
                <line x1="20" y1="11" x2="20" y2="13" />
              </svg>
            </span>
            <span className="file-details">
              <span className="file-name">{file.name}</span>
              <span className="file-meta">
                {detectType(file.name)} &middot; {formatFileSize(file.size)}
              </span>
            </span>
          </div>
        ) : (
          <div className="drop-prompt">
            <span className="drop-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 16V4" />
                <path d="M7 9l5-5 5 5" />
                <path d="M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" />
              </svg>
            </span>
            <p className="drop-title">Drop an audio file here</p>
            <p className="drop-sub">or click to browse</p>
            <span className="drop-hint">.mp3 &middot; .wav &middot; .flac &middot; .ogg</span>
          </div>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_STRING}
        onChange={handleChange}
        hidden
        aria-hidden="true"
      />
    </div>
  );
}
