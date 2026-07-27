export function ErrorBanner({ error, onDismiss }: { error: string | null; onDismiss: () => void }) {
  if (!error) return null;
  return (
    <div className="error" role="alert">
      <pre>{error}</pre>
      <button onClick={onDismiss} aria-label="Dismiss error">
        &times;
      </button>
    </div>
  );
}
