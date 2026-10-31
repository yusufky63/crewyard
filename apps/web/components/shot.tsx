import shots from "@/lib/shots.json";

// A real screenshot of the app, taken by scripts/shots.mjs in the app's own screenshot mode with its
// sample data, in the theme the page shows. lib/shots.json lists what the script wrote; a name it
// does not list renders nothing rather than an empty frame.

type ShotEntry = { width: number; height: number; dark: string; light: string };
const SHOTS = shots as Record<string, ShotEntry>;

export function Shot({ name, title, alt, priority = false }: { name: string; title: string; alt: string; priority?: boolean }) {
  const s = SHOTS[name];
  if (!s) return null;
  const loading = priority ? "eager" : "lazy";
  return (
    <figure className="shot">
      <figcaption className="shot-bar">
        <b>{title}</b>
        <span>Sample data</span>
      </figcaption>
      {/* Both themes are in the page; CSS shows the one that matches, and a lazy image that is not shown is not fetched. */}
      <img className="only-dark" src={s.dark} width={s.width} height={s.height} alt={alt} loading={loading} decoding="async" />
      <img className="only-light" src={s.light} width={s.width} height={s.height} alt={alt} loading="lazy" decoding="async" />
    </figure>
  );
}
