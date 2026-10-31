"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

/** A command or hash with a Copy button. The text is shown as text, never as markup. */
export function CodeBlock({ code, label = "Copy", wrap = false }: { code: string; label?: string; wrap?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => undefined);
  };
  return (
    <div className={wrap ? "code code-wrap" : "code"}>
      <pre>
        <code>{code}</code>
      </pre>
      <button type="button" className="btn btn-sm copy" onClick={copy}>
        {copied ? <Check strokeWidth={1.5} aria-hidden /> : <Copy strokeWidth={1.5} aria-hidden />}
        <span aria-live="polite">{copied ? "Copied" : label}</span>
      </button>
    </div>
  );
}
