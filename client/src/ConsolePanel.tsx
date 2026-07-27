import { useEffect, useRef, useState } from "react";
import type { ConsoleEntry } from "./useDaemon";

const FOLLOW_THRESHOLD_PX = 24;

export function ConsolePanel({ lines }: { lines: ConsoleEntry[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines, follow]);

  return (
    <section className="console">
      <div
        className="console-body"
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD_PX);
        }}
      >
        {lines.map((l, i) => (
          <div key={i} className={l.kind === "task" ? "line line-task" : "line"}>
            {l.line}
          </div>
        ))}
      </div>
      {!follow && (
        <button className="follow" onClick={() => setFollow(true)}>
          Jump to latest
        </button>
      )}
    </section>
  );
}
