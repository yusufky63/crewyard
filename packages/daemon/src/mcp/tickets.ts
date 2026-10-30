import { createHash, randomBytes } from "node:crypto";

// One ticket per live run process (docs/adr/0007). The report server's relay sends it as the first
// line on the pipe; the daemon keeps only its hash. A new process of the same run (resume, a
// continue after a pause) gets a new ticket and the old one stops working, as does every ticket
// of a run that ended. Tickets live in memory only: a daemon restart ends every run process, so
// nothing could still hold a valid one.

const hash = (ticket: string) => createHash("sha256").update(ticket, "utf8").digest("hex");

export class RunTickets {
  /** ticket hash -> run id */
  private readonly byHash = new Map<string, string>();
  /** run id -> its current ticket hash */
  private readonly byRun = new Map<string, string>();

  /** A fresh ticket for the run; any earlier ticket of the same run is revoked. */
  issue(runId: string): string {
    this.revoke(runId);
    const ticket = randomBytes(32).toString("base64url");
    const h = hash(ticket);
    this.byHash.set(h, runId);
    this.byRun.set(runId, h);
    return ticket;
  }

  /** The run a ticket belongs to, or null for a wrong, old or revoked one. */
  runFor(ticket: unknown): string | null {
    if (typeof ticket !== "string" || ticket.length < 32 || ticket.length > 128) return null;
    return this.byHash.get(hash(ticket)) ?? null;
  }

  revoke(runId: string): void {
    const h = this.byRun.get(runId);
    if (h) this.byHash.delete(h);
    this.byRun.delete(runId);
  }

  /** Whether the run holds a live ticket; a connection checks this on every call. */
  current(runId: string, ticket: string): boolean {
    return this.byRun.get(runId) === hash(ticket);
  }
}
