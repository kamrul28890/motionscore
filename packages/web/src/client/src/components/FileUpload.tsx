import { useCallback, useRef, useState } from 'react';

const ACCEPTED_EXTENSIONS = ['.mid', '.midi', '.wav', '.mp3', '.flac', '.ogg'];
const ACCEPT_STRING = ACCEPTED_EXTENSIONS.map((e) => (e === '.mid' ? 'audio/midi' : e === '.midi' ? 'audio/midi' : `audio/${e.slice(1)}`)).join(',') + ',' + ACCEPTED_EXTENSIONS.join(',');

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function detectType(filename: string): string {
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '';
  if (['.mid', '.midi'].includes(ext)) return 'MIDI';
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
      <h2>Input File</h2>
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
            <div className="file-icon">{detectType(file.name) === 'MIDI' ? '🎹' : '🎵'}</div>
            <div className="file-details">
              <span className="file-name">{file.name}</span>
              <span className="file-meta">
                {detectType(file.name)} &middot; {formatFileSize(file.size)}
              </span>
            </div>
          </div>
        ) : (
          <div className="drop-prompt">
            <div className="drop-icon">📁</div>
            <p>Drag and drop a file here, or click to browse</p>
            <span className="drop-hint">.mid, .midi, .wav, .mp3, .flac, .ogg</span>
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
