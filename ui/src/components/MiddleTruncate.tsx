/** Long paths lose their middle, not their end: the folder and database name stay visible. */
export function MiddleTruncate({
  text,
  before = "",
  after = "",
  className = "",
}: {
  text: string;
  /** Kept whole on the left, e.g. the engine name. */
  before?: string;
  /** On the right, e.g. the auth label; it gives way once the path is cut to its minimum. */
  after?: string;
  className?: string;
}) {
  const cut = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  const head = cut > 0 && text.length > 40 ? text.slice(0, cut + 1) : text;
  const tail = head === text ? "" : text.slice(cut + 1);
  return (
    <span className={`flex min-w-0 whitespace-pre ${className}`} title={`${before}${text}${after}`}>
      {before && <span className="shrink-0">{before}</span>}
      <span className="truncate min-w-[3ch]">{head}</span>
      {tail && <span className="shrink-0">{tail}</span>}
      {after && <span className="truncate min-w-0">{after}</span>}
    </span>
  );
}
