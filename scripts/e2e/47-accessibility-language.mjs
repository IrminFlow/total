// Scenario 47: scalable reading preferences, bilingual navigation, regional invoice labels,
// voice-friendly names and consent-gated accessibility support context.
import { scenario, assert, assertEq } from "../lib/harness.mjs";

await scenario("47-accessibility-language", async (h) => {
  await h.createDemoCompany();
  await h.invoke("device-safety:set", {
    aiCopilot: false,
    mcpAccess: false,
    supportUploads: true,
    telemetry: false,
  });
  await h.page.evaluate(() => window.dispatchEvent(new Event("total:device-safety-refresh")));
  await h.page.setViewportSize({ width: 1080, height: 700 });
  const minimumShell = await h.page.evaluate(() => {
    const header = document.querySelector('[data-testid="app-header"]');
    const supportEmail = header?.querySelector('.support-email');
    const rect = header?.getBoundingClientRect();
    const controls = header ? [...header.querySelectorAll('button')] : [];
    return {
      headerHeight: rect?.height ?? 0,
      headerScrollHeight: header?.scrollHeight ?? 0,
      controlsStayInside: Boolean(
        rect && controls.every((control) => {
          const controlRect = control.getBoundingClientRect();
          return controlRect.top >= rect.top - 1 && controlRect.bottom <= rect.bottom + 1;
        }),
      ),
      supportEmailVisible: supportEmail ? getComputedStyle(supportEmail).display !== 'none' : false,
    };
  });
  assert(
    minimumShell.headerScrollHeight <= minimumShell.headerHeight + 1 && minimumShell.controlsStayInside,
    `1080x700 header stays on one line: ${JSON.stringify(minimumShell)}`,
  );
  assert(minimumShell.supportEmailVisible, "support email remains visible in the minimum-width top bar");
  await h.shot("00-minimum-shell");
  await h.page.setViewportSize({ width: 1440, height: 900 });
  await h.goto("settings");
  await h.page
    .getByRole("button", { name: "Accessibility", exact: true })
    .click();
  await h.page.locator('[data-testid="accessibility-settings"]').waitFor();

  await h.page.getByRole("button", { name: /Large 112%/ }).click();
  await h.page
    .getByRole("button", { name: "Reduce motion", exact: true })
    .click();
  await h.page
    .getByRole("button", { name: /International 12,345,678\.00/ })
    .click();
  let preferences = await h.page.evaluate(() => ({
    fontScale: document.documentElement.dataset.fontScale,
    motion: document.documentElement.dataset.motion,
    readingMode: document.documentElement.dataset.readingMode,
    horizontalOverflow:
      document.documentElement.scrollWidth > window.innerWidth + 1,
  }));
  assertEq(preferences.fontScale, "large", "large text preference is applied");
  assertEq(preferences.motion, "reduce", "manual reduced motion is applied");
  assert(
    !preferences.horizontalOverflow,
    "large text does not overflow the app viewport",
  );
  await h.page.getByText("12,345,678.90", { exact: true }).waitFor();

  await h.page
    .getByRole("button", { name: "Spaced text", exact: true })
    .click();
  await h.page
    .getByRole("button", { name: "हिंदी + English", exact: true })
    .click();
  preferences = await h.page.evaluate(() => ({
    language: document.documentElement.lang,
    readingMode: document.documentElement.dataset.readingMode,
    dayBookName: document
      .querySelector('[data-testid="nav-daybook"]')
      ?.getAttribute("aria-label"),
    voiceCommand: document
      .querySelector('[data-testid="nav-daybook"]')
      ?.getAttribute("data-voice-command"),
  }));
  assertEq(
    preferences.language,
    "hi",
    "document language follows the Hindi preference",
  );
  assertEq(
    preferences.readingMode,
    "dyslexia",
    "spaced reading mode is applied",
  );
  assert(
    preferences.dayBookName?.includes("Day book"),
    "bilingual accessible name keeps the English accounting term",
  );
  assertEq(
    preferences.voiceCommand,
    "Day book",
    "voice-command identity stays stable",
  );
  const resilientSidebar = await h.page.evaluate(() => {
    const sidebar = document.querySelector('[data-testid="primary-navigation"]');
    const itemHeights = sidebar
      ? [...sidebar.querySelectorAll('.app-nav-item')].map((item) => item.getBoundingClientRect().height)
      : [];
    return {
      width: sidebar?.getBoundingClientRect().width ?? 0,
      horizontalOverflow: sidebar ? sidebar.scrollWidth > sidebar.clientWidth + 1 : true,
      tallestItem: Math.max(0, ...itemHeights),
    };
  });
  assert(
    resilientSidebar.width >= 240 && !resilientSidebar.horizontalOverflow && resilientSidebar.tallestItem < 60,
    `large Hindi sidebar remains scan-friendly: ${JSON.stringify(resilientSidebar)}`,
  );
  await h.shot("01-large-hindi-spaced");

  // Restore English before exercising existing settings navigation and invoice preview.
  await h.page
    .getByRole("button", { name: "Restore defaults", exact: true })
    .click();
  const invoiceConfig = await h.invoke("config:invoice:get");
  await h.invoke("config:invoice:set", {
    ...invoiceConfig,
    labelLanguage: "hi",
  });
  await h.page
    .getByRole("button", { name: "Invoice print", exact: true })
    .click();
  const invoiceFrame = h.page.frameLocator('iframe[title="Invoice preview"]');
  await invoiceFrame
    .getByText("बिल प्राप्तकर्ता", { exact: true })
    .waitFor({ state: "attached" });
  const invoiceText = await invoiceFrame.locator("body").textContent();
  assert(
    invoiceText.includes("बिल प्राप्तकर्ता"),
    "saved Hindi labels render in the read-only invoice preview",
  );
  await h.shot("02-hindi-invoice-labels");

  // Focus metadata is opt-in and excludes the focused field's value. Screenshot capture has a
  // separate explicit consent and shows a preview before it can be submitted.
  await h.page.locator('[data-testid="nav-settings"]').focus();
  await h.click("link-support");
  await h.page
    .getByText(
      "Include the last focused control's safe name, role and screen. No entered value is included.",
      { exact: true },
    )
    .click();
  const focusPayload = await h.page
    .locator('[data-testid="support-focus-preview"]')
    .textContent();
  assert(
    focusPayload.includes("Settings"),
    "focused control name is previewed",
  );
  await h.page
    .getByText(
      "Include a screenshot of the current app window. Capture starts only after this box is checked.",
      { exact: true },
    )
    .click();
  await h.page.locator('[data-testid="support-screenshot-preview"]').waitFor();
  await h.shot("03-accessibility-report-consent");
});
