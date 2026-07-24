interface ConfigFormProps {
  onGenerate: () => void;
  disabled: boolean;
  canGenerate: boolean;
}

export function ConfigForm({ onGenerate, disabled, canGenerate }: ConfigFormProps) {
  return (
    <div className="card config-card">
      <button
        className="btn btn-primary btn-generate"
        onClick={onGenerate}
        disabled={disabled || !canGenerate}
        type="button"
      >
        {disabled ? (
          <>
            <span className="btn-spinner" aria-hidden="true" />
            Analyzing&hellip;
          </>
        ) : (
          'Generate visualization'
        )}
      </button>
      <p className="config-hint">
        {canGenerate
          ? 'Separates the track into per-instrument stems, then solves the physics scene. This can take a few minutes.'
          : 'Add an audio file to enable analysis.'}
      </p>
    </div>
  );
}
