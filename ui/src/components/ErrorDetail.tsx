// Traces: BASED-ERROR-HEADLINE — the headline up front, the whole driver text one click away.
import { errorHeadline } from "../lib/errorText";

export function ErrorDetail({ message }: { message: string }) {
  const headline = errorHeadline(message);
  return (
    <>
      <div className="font-mono text-err whitespace-pre-wrap break-words">{headline}</div>
      {headline !== message.trim() && (
        <details className="mt-1 text-[length:var(--fs-sm)] text-muted">
          <summary className="cursor-pointer hover:text-paper-dim">Full error</summary>
          <div className="mt-1 font-mono whitespace-pre-wrap break-words">{message}</div>
        </details>
      )}
    </>
  );
}

export function ErrorBox({ message, className = "" }: { message: string; className?: string }) {
  return (
    <div role="alert" className={`px-3 py-2 text-[length:var(--fs-base)] bg-err/10 border border-err/30 rounded ${className}`}>
      <ErrorDetail message={message} />
    </div>
  );
}
