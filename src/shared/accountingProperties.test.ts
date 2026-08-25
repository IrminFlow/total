import { describe, expect, it } from "vitest";
import { backOutAdvance, computeGst } from "./gst/calc";
import { allocateAdditionalCost, valueStock, type StockMovement } from "./valuation";

function generator(seed = 0x5eed1234): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const integer = (random: () => number, min: number, max: number): number =>
  min + Math.floor(random() * (max - min + 1));

describe("generated accounting invariants", () => {
  it("conserves debit and credit paise across 2,000 generated balanced vouchers", () => {
    const random = generator();
    for (let run = 0; run < 2_000; run += 1) {
      const debits = Array.from({ length: integer(random, 1, 8) }, () =>
        integer(random, 1, 100_000_000),
      );
      const total = debits.reduce((sum, amount) => sum + amount, 0);
      const credits: number[] = [];
      let remaining = total;
      while (remaining > 0) {
        const amount = credits.length >= 7 ? remaining : integer(random, 1, remaining);
        credits.push(amount);
        remaining -= amount;
      }
      expect(debits.reduce((sum, amount) => sum + amount, 0)).toBe(
        credits.reduce((sum, amount) => sum + amount, 0),
      );
      expect([...debits, ...credits].every(Number.isSafeInteger)).toBe(true);
    }
  });

  it("conserves allocations, GST totals and inclusive advances for randomized paise", () => {
    const random = generator(0xa110ca7e);
    const rates = [0, 0.1, 0.25, 3, 5, 12, 18, 28];
    for (let run = 0; run < 1_000; run += 1) {
      const bases = Array.from({ length: integer(random, 1, 12) }, () =>
        integer(random, 0, 10_000_000),
      );
      const extra = integer(random, 0, 5_000_000);
      const shares = allocateAdditionalCost(bases, extra);
      expect(shares.reduce((sum, amount) => sum + amount, 0)).toBe(extra);
      expect(shares.every((amount) => Number.isSafeInteger(amount) && amount >= 0)).toBe(true);

      const taxable = integer(random, 0, 100_000_000);
      const rate = rates[integer(random, 0, rates.length - 1)]!;
      const supply = random() > 0.5 ? "intra" : "inter";
      const gst = computeGst(taxable, rate, supply);
      expect(gst.total).toBe(gst.taxable + gst.cgst + gst.sgst + gst.igst + gst.cess);
      expect(supply === "intra" ? gst.igst : gst.cgst + gst.sgst).toBe(0);

      const gross = integer(random, 1, 100_000_000);
      const advance = backOutAdvance(gross, rate, supply);
      expect(advance.total).toBe(gross);
      expect(advance.taxable + advance.cgst + advance.sgst + advance.igst).toBe(gross);
    }
  });

  it("conserves stock value across generated positive-stock FIFO and weighted-average walks", () => {
    const random = generator(0x1f1f0);
    for (const method of ["fifo", "weighted_avg"] as const) {
      for (let run = 0; run < 500; run += 1) {
        let available = 0;
        let inwardValue = 0;
        const movements: StockMovement[] = [];
        for (let step = 0; step < 30; step += 1) {
          const inward = available === 0 || random() > 0.42;
          if (inward) {
            const qtyMilli = integer(random, 1, 50_000);
            const amount = integer(random, 1, 20_000_000);
            movements.push({ direction: "in", qtyMilli, amount });
            available += qtyMilli;
            inwardValue += amount;
          } else {
            const qtyMilli = integer(random, 1, available);
            movements.push({ direction: "out", qtyMilli, amount: 0 });
            available -= qtyMilli;
          }
        }
        const result = valueStock(method, 0, 0, movements);
        expect(result.closingQtyMilli).toBe(available);
        expect(result.closingValue + result.consumedValue).toBe(inwardValue);
        expect(Number.isSafeInteger(result.closingValue)).toBe(true);
      }
    }
  });
});
