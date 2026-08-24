/**
 * ===========================================================================================
 *  EMPTY ON PURPOSE. DO NOT FILL THIS IN WITH ANYTHING A CUSTOMER DID NOT ACTUALLY SAY.
 * ===========================================================================================
 *
 * A made-up testimonial on a site that sells accounting software to businesses is not marketing
 * copy, it is a false statement of fact about a named person. It is also the easiest thing in
 * the world to catch: the named firm gets one phone call and the whole product is finished.
 *
 * OPERATOR: add an entry only when all four of these are true.
 *   1. The person exists, uses Total, and said the words in `quote` in writing.
 *   2. You have their written permission to publish their name, role and firm.
 *   3. Nothing in the quote was edited beyond trimming. Trimming is marked with an ellipsis.
 *   4. `permissionOn` records the date they gave permission, so it can be produced later.
 *
 * The component renders nothing at all while this list is empty. That is the correct behaviour:
 * a site with no testimonials reads as new, and a site with invented ones reads as dishonest.
 */

export interface Testimonial {
  /** Their words, trimmed but not rewritten. Keep it under about thirty words. */
  quote: string
  name: string
  /** Role and firm, as they want it published. */
  role: string
  /** Town or city, if they are happy for it to appear. */
  place?: string
  /** ISO date they gave written permission. Required. */
  permissionOn: string
}

export const TESTIMONIALS: Testimonial[] = []
