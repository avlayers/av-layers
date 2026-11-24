/**
 * p-retry stops at once on a TypeError it does not recognise as a network error
 * and on a thrown non-Error. Loops that retry every failure wrap those here.
 */
export function retriable(error: unknown): unknown {
  if (error instanceof Error && !(error instanceof TypeError)) return error;
  return new Error(error instanceof Error ? error.message : String(error), { cause: error });
}
