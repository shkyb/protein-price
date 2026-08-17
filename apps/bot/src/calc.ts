/**
 * Core calculation, kept isolated so it's trivial to reuse verbatim from the
 * PWA later (same formula, same rounding behavior, no drift between the two).
 */
export function computeValuePerGramProtein(
  price: number,
  weightGrams: number,
  proteinPer100g: number
): number {
  const totalProteinGrams = (weightGrams * proteinPer100g) / 100;
  if (totalProteinGrams <= 0) {
    throw new Error("Protein amount must be greater than zero");
  }
  return price / totalProteinGrams;
}
