import { describe, expect, it } from "vitest";
import { seededDb } from "../db/testdb";
import { createStockItem } from "./masters";
import {
  createCurrency,
  deleteCurrency,
  getBom,
  itemsWithBom,
  listCurrencies,
  setBom,
} from "./extras";

function stockItem(
  db: ReturnType<typeof seededDb>,
  name: string,
): ReturnType<typeof createStockItem> {
  const unit = db
    .prepare("SELECT id FROM units ORDER BY id LIMIT 1")
    .get() as { id: number };
  return createStockItem(db, {
    name,
    groupId: null,
    unitId: unit.id,
    hsn: null,
    gstRate: 0,
    cessRate: null,
    openingQtyMilli: 0,
    openingValue: 0,
    barcode: null,
    reorderLevelMilli: null,
    valuationMethod: "weighted_avg",
  });
}

describe("currency and BOM services", () => {
  it("creates, lists and deletes an unused currency", () => {
    const db = seededDb();
    const created = createCurrency(db, {
      code: "USD",
      symbol: "$",
      name: "US Dollar",
      decimals: 2,
    });

    expect(listCurrencies(db)).toContainEqual(created);
    deleteCurrency(db, created.id);
    expect(listCurrencies(db).some((row) => row.id === created.id)).toBe(false);
  });

  it("round-trips a BOM and lists only manufactured items", () => {
    const db = seededDb();
    const assembly = stockItem(db, "Pump assembly");
    const component = stockItem(db, "Pump casing");

    expect(
      setBom(db, {
        itemId: assembly.id,
        lines: [{ componentId: component.id, qtyMilliPerUnit: 2_000 }],
      }),
    ).toEqual([
      expect.objectContaining({
        componentId: component.id,
        componentName: "Pump casing",
        qtyMilliPerUnit: 2_000,
      }),
    ]);
    expect(getBom(db, assembly.id)).toHaveLength(1);
    expect(itemsWithBom(db)).toEqual([
      { itemId: assembly.id, name: "Pump assembly", components: 1 },
    ]);
  });

  it("rejects direct and transitive BOM cycles without replacing saved lines", () => {
    const db = seededDb();
    const assembly = stockItem(db, "Assembly");
    const subassembly = stockItem(db, "Subassembly");

    expect(() =>
      setBom(db, {
        itemId: assembly.id,
        lines: [{ componentId: assembly.id, qtyMilliPerUnit: 1_000 }],
      }),
    ).toThrow("own component");

    setBom(db, {
      itemId: assembly.id,
      lines: [{ componentId: subassembly.id, qtyMilliPerUnit: 1_000 }],
    });
    expect(() =>
      setBom(db, {
        itemId: subassembly.id,
        lines: [{ componentId: assembly.id, qtyMilliPerUnit: 1_000 }],
      }),
    ).toThrow("create a cycle");
    expect(getBom(db, assembly.id)).toHaveLength(1);
    expect(getBom(db, subassembly.id)).toEqual([]);
  });
});
