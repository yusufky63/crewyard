import type { ComponentProps } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

// A release body is text someone typed on GitHub, so it is rendered as Markdown into React
// elements only: raw HTML in it is dropped (skipHtml), URLs pass react-markdown's protocol check
// (http, https, mailto and relative only), links open in a new tab without an opener or referrer,
// and images are never fetched from the page: they become links with their alt text.

const MAX_CHARS = 60_000;

function A({ href, children }: ComponentProps<"a">) {
  if (!href) return <>{children}</>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function Img({ src, alt }: ComponentProps<"img">) {
  const label = alt?.trim() || "Image";
  if (typeof src !== "string" || !src) return <span>{label}</span>;
  return (
    <a href={src} target="_blank" rel="noopener noreferrer">
      {`Image: ${label}`}
    </a>
  );
}

/** Headings inside a release body sit under the release's own h2. */
function H({ children }: ComponentProps<"h3">) {
  return <h3>{children}</h3>;
}

export function ReleaseNotes({ body }: { body: string }) {
  const text = body.length > MAX_CHARS ? `${body.slice(0, MAX_CHARS)}\n\n…` : body;
  if (!text.trim()) return <p className="cta-note">No release notes.</p>;
  return (
    <div className="md">
      <Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={defaultUrlTransform} components={{ a: A, img: Img, h1: H, h2: H, h3: H }}>
        {text}
      </Markdown>
    </div>
  );
}
