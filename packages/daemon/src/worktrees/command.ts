import { createHash } from "node:crypto";

export { splitCommand } from "@crewyard/core";

/** The approval key: sha256 of the exact text, so changing even one character asks again. */
export const commandHash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
