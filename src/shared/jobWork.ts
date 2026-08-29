/**
 * Job work — the naming of the godown that holds a job worker's stock (roadmap E #127).
 *
 * This file used to be the whole of a second job-work implementation: a section 143 clock, a
 * due-date calculator, a return planner. All of that already existed, better, in
 * `@shared/gst/itc04` — which the ITC-04 lane (#89) built alongside the return that has to agree
 * with it — so it was dropped at the merge rather than kept as a second answer to the same
 * question. What survived is the one thing that lane did not have: the goods have to actually
 * MOVE, and they move into a godown named for the job worker.
 *
 * The accounting fact behind that: **sending goods for job work is not a sale.** Title never
 * leaves the principal. Nothing is bought, nothing is sold, no money moves and no ledger is
 * touched — exactly like a godown transfer, which is how `services/jobWork.ts` records it. The
 * goods stay on the principal's books, which is what keeps them in his closing stock, where they
 * belong.
 *
 * A named godown PER job worker, rather than one pooled "Job work" godown, because the question a
 * principal is asked in a GST audit is "what is lying with WHOM", and a pooled godown answers it
 * with a single number covering four job workers. The prefix keeps them together in an
 * alphabetical godown list, where they would otherwise be scattered among the real premises.
 */

/** The godown a job worker's stock sits in. The only place this name is spelt. */
export function jobWorkGodownName(partyName: string): string {
  return `Job work — ${partyName}`.slice(0, 60)
}

export function isJobWorkGodown(name: string): boolean {
  return name.startsWith('Job work — ')
}
