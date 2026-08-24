// Scenario 40 — independent review, period sign-off, temporary access and control reporting.
import { scenario, assert, assertEq } from "../lib/harness.mjs";

await scenario("40-control-room", async (h) => {
  await h.createCompanyUI("Assurance Works");
  const groups = await h.invoke("master:groups:list");
  const types = await h.invoke("master:voucherTypes:list");
  const expense = await h.invoke("master:ledgers:create", {
    name: "Review Expense",
    groupId: groups.find((row) => row.name === "Indirect Expenses").id,
    openingBalance: 0,
    gstin: null,
    stateCode: null,
    address: null,
    taxType: null,
    gstRate: null,
    hsn: null,
  });
  const cash = await h.invoke("master:ledgers:create", {
    name: "Review Cash",
    groupId: groups.find((row) => row.name === "Cash-in-Hand").id,
    openingBalance: 0,
    gstin: null,
    stateCode: null,
    address: null,
    taxType: null,
    gstRate: null,
    hsn: null,
  });
  const journal = types.find((row) => row.kind === "journal");
  const today = new Date().toISOString().slice(0, 10);
  const voucher = await h.invoke("voucher:save", {
    data: {
      voucherTypeId: journal.id,
      date: today,
      partyLedgerId: null,
      narration: "Control review fixture",
      reference: null,
      instrumentNo: null,
      instrumentDate: null,
      transporterId: null,
      vehicleNo: null,
      transportDistanceKm: null,
      posOverride: null,
      currencyCode: null,
      exchangeRate: null,
      lines: [
        { ledgerId: expense.id, drCr: "dr", amount: 250000 },
        { ledgerId: cash.id, drCr: "cr", amount: 250000 },
      ],
      inventory: [],
      billRefs: [],
      tds: null,
    },
  });

  const owner = await h.invoke("users:save", {
    data: {
      name: "Owner",
      role: "owner",
      pin: "1111",
      active: true,
      accessExpiresAt: null,
    },
  });
  const accountant = await h.invoke("users:save", {
    data: {
      name: "Asha",
      role: "accountant",
      pin: "2222",
      active: true,
      accessExpiresAt: null,
    },
  });
  await h.invoke("users:save", {
    data: {
      name: "Visiting auditor",
      role: "viewer",
      pin: "3333",
      active: true,
      accessExpiresAt: new Date(Date.now() + 86400000).toISOString(),
    },
  });
  const question = await h.invoke("controls:review:create", {
    voucherId: voucher.id,
    question: "Confirm the approval evidence for this expense",
    assignedToUserId: accountant.id,
    dueDate: today,
    priority: "urgent",
  });

  await h.invoke("auth:logout");
  await h.invoke("auth:login", { userId: accountant.id, pin: "2222" });
  await h.invoke("controls:review:answer", {
    id: question.id,
    answer: "Approval reference AW-2026-081 is retained in the working papers.",
  });
  const month = today.slice(0, 7);
  const last = new Date(
    Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0),
  ).getUTCDate();
  const from = `${month}-01`,
    to = `${month}-${String(last).padStart(2, "0")}`;
  await h.invoke("controls:signoff:prepare", {
    from,
    to,
    outstandingIssues: ["One advisory validation warning"],
    evidence: ["verified-backup.totalbak", "AW-2026-081"],
  });
  const exception = await h.invoke("controls:exceptions:request", {
    policyKind: "period_lock",
    entityType: "company",
    entityId: null,
    reason: "Reopen solely to post the documented bank charge",
  });

  await h.invoke("auth:logout");
  await h.invoke("auth:login", { userId: owner.id, pin: "1111" });
  await h.invoke("controls:review:resolve", { id: question.id });
  await h.invoke("controls:signoff:review", {
    from,
    to,
    note: "Evidence reviewed independently; advisory issue accepted.",
  });
  await h.invoke("controls:exceptions:decide", {
    id: exception.id,
    approved: true,
    note: "One controlled reopening approved.",
  });
  await h.invoke("company:lock:set", { date: to });
  let blocked = false;
  try {
    await h.invoke("company:lock:set", { date: null });
  } catch (error) {
    blocked = String(error).includes("approved period lock exception");
  }
  assert(blocked, "lock removal is blocked without an approved exception");
  await h.invoke("company:lock:set", { date: null, exceptionId: exception.id });

  await h.page.keyboard.press("o");
  await h.waitScreen("control-room");
  await h.page
    .getByRole("heading", { name: "Control room", exact: true })
    .waitFor();
  await h.page.getByText("reviewed", { exact: true }).waitFor();
  await h.shot("01-control-overview");
  await h.click("control-tab-review");
  await h.page
    .getByText("Confirm the approval evidence for this expense", {
      exact: true,
    })
    .waitFor();
  await h.page.getByText("resolved", { exact: true }).waitFor();
  await h.shot("02-resolved-review");
  await h.click("control-tab-signoff");
  await h.page.getByText("Reviewed by Owner", { exact: true }).waitFor();
  await h.shot("03-period-signoff");
  await h.click("control-tab-exceptions");
  await h.page.getByText("used", { exact: true }).waitFor();
  await h.shot("04-exception-register");
  await h.click("control-tab-access");
  await h.page.getByText("Device sessions", { exact: true }).waitFor();
  await h.page
    .getByText("Visiting auditor", { exact: true })
    .waitFor({ state: "detached" })
    .catch(() => {});
  await h.shot("05-access-controls");
  await h.click("control-tab-evidence");
  await h.page.getByText("Evidence lifecycle", { exact: true }).waitFor();
  await h.shot("06-evidence-retention");
  const report = await h.invoke("controls:report", { from, to });
  assertEq(
    report.periodSignoffStatus,
    "reviewed",
    "period is independently reviewed",
  );
  assertEq(report.overrides, 1, "used policy exception is reported");
});
