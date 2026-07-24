interface ConfigFormProps {
  onGenerate: () => void;
  disabled: boolean;
  canGenerate: boolean;
}

export function ConfigForm({ onGenerate, disabled, canGenerate }: ConfigFormProps) {
  return (
    <div className="card">
      <button
        className="btn btn-primary btn-generate"
        onClick={onGenerate}
        disabled={disabled || !canGenerate}
        type="button"
      >
        {disabled ? 'Analyzing...' : 'Generate'}
      </button>
    </div>
  );
}
