import { describe, expect, it } from "vitest";
import { seededDb } from "../db/testdb";
import { createLedger, listLedgers, updateLedger } from "./masters";

describe("party contact channels", () => {
  it("stores normalized email and phone values without affecting accounting fields", () => {
    const db = seededDb();
    const group = db
      .prepare("SELECT id FROM groups WHERE name='Sundry Debtors'")
      .get() as { id: number };
    const created = createLedger(db, {
      name: "Contact Customer",
      groupId: group.id,
      openingBalance: 125_000,
      email: "accounts@example.com",
      phone: "+919876543210",
    });
    expect(created).toMatchObject({
      email: "accounts@example.com",
      phone: "+919876543210",
      openingBalance: 125_000,
    });
    const updated = updateLedger(db, created.id, {
      ...created,
      email: null,
      phone: null,
    });
    expect(updated).toMatchObject({ email: null, phone: null, openingBalance: 125_000 });
    expect(listLedgers(db).find((row) => row.id === created.id)).toEqual(updated);
  });
});
