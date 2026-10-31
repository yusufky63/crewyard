import { OG, renderCard } from "@/lib/og";

export const alt = "How Crewyard works: one task from your words to a merged pull request";
export const size = OG.size;
export const contentType = "image/png";

export default function Image() {
  return renderCard({
    eyebrow: "How it works",
    title: "From a task to a merged pull request",
    lead: "A crew proposal with reasons and estimates, runs in git worktrees, the Inbox, and your click at every gate.",
    facts: ["Propose", "Approve", "Run", "Review", "Merge"],
  });
}
