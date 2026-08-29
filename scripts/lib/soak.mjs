export function parseSoakIterations(raw = "20") {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 2 || value > 200) {
    throw new Error("TOTAL_SOAK_ITERATIONS must be a whole number from 2 to 200");
  }
  return value;
}
