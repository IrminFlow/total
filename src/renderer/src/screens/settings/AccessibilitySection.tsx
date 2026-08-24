import {
  ArrowsOutLineHorizontal,
  Eye,
  Keyboard,
  TextAa,
} from "@phosphor-icons/react";
import { localeGuidance } from "@shared/localeHelp";
import { formatPaise } from "@shared/money";
import { Button, Panel, SectionTitle } from "../../components/ui";
import {
  useAccessibilityPreferences,
  type AccessibilityPreferences,
} from "../../lib/accessibilityPrefs";
import { useSession } from "../../state/stores";

const FONT_OPTIONS = [
  { value: "default", label: "Default", detail: "100%" },
  { value: "large", label: "Large", detail: "112%" },
  { value: "xlarge", label: "Extra large", detail: "122%" },
] as const;

function Choice<K extends keyof AccessibilityPreferences>({
  preference,
  options,
}: {
  preference: K;
  options: readonly {
    value: AccessibilityPreferences[K];
    label: string;
    detail?: string;
  }[];
}): React.JSX.Element {
  const current = useAccessibilityPreferences((state) => state[preference]);
  const setPreference = useAccessibilityPreferences(
    (state) => state.setPreference,
  );
  return (
    <div className="grid grid-cols-3 gap-1 rounded-md border border-line bg-panel2 p-1">
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          aria-pressed={current === option.value}
          onClick={() => setPreference(preference, option.value)}
          className={`min-h-10 rounded px-2 py-1.5 text-left ${
            current === option.value
              ? "bg-ink text-bg"
              : "text-muted hover:bg-panel hover:text-ink"
          }`}
        >
          <span className="block whitespace-nowrap text-[11.5px] font-medium">
            {option.label}
          </span>
          {option.detail && (
            <span className="num mt-0.5 block text-[9.5px] opacity-75">
              {option.detail}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export function AccessibilitySection(): React.JSX.Element {
  const info = useSession((state) => state.info);
  const reset = useAccessibilityPreferences((state) => state.reset);
  const numberGrouping = useAccessibilityPreferences(
    (state) => state.numberGrouping,
  );
  const guidance = info ? localeGuidance(info) : null;

  return (
    <div data-testid="accessibility-settings">
      <div className="mb-5 flex items-start justify-between gap-5">
        <div>
          <SectionTitle>Accessibility and language</SectionTitle>
          <p className="mt-1 max-w-[62ch] text-[12px] leading-5 text-muted">
            Reading preferences stay on this Mac. They do not alter company
            books, exported data or saved invoice content.
          </p>
        </div>
        <Button onClick={reset}>Restore defaults</Button>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(260px,0.78fr)] gap-5 max-[900px]:grid-cols-1">
        <Panel className="p-5">
          <div className="space-y-5">
            <section aria-labelledby="font-size-heading">
              <div className="mb-2 flex items-center gap-2">
                <TextAa size={18} aria-hidden="true" />
                <h3
                  id="font-size-heading"
                  className="text-[13px] font-semibold"
                >
                  Text size
                </h3>
              </div>
              <Choice preference="fontScale" options={FONT_OPTIONS} />
              <p className="mt-2 text-[11px] leading-4 text-muted">
                Tables and dialogs keep their scroll areas when text grows.
              </p>
            </section>

            <section aria-labelledby="reading-heading">
              <div className="mb-2 flex items-center gap-2">
                <Eye size={18} aria-hidden="true" />
                <h3 id="reading-heading" className="text-[13px] font-semibold">
                  Reading comfort
                </h3>
              </div>
              <Choice
                preference="readingMode"
                options={[
                  { value: "standard", label: "Standard" },
                  { value: "dyslexia", label: "Spaced text" },
                ]}
              />
              <div className="mt-2">
                <Choice
                  preference="motion"
                  options={[
                    { value: "system", label: "System motion" },
                    { value: "reduce", label: "Reduce motion" },
                  ]}
                />
              </div>
            </section>

            <section aria-labelledby="language-heading">
              <div className="mb-2 flex items-center gap-2">
                <Keyboard size={18} aria-hidden="true" />
                <h3 id="language-heading" className="text-[13px] font-semibold">
                  Navigation language
                </h3>
              </div>
              <Choice
                preference="language"
                options={[
                  { value: "en", label: "English" },
                  { value: "hi", label: "हिंदी + English" },
                ]}
              />
              <p className="mt-2 text-[11px] leading-4 text-muted">
                Hindi navigation keeps the English accounting term in brackets.
                macOS Voice Control can use the same visible, stable screen
                names.
              </p>
            </section>

            <section aria-labelledby="numbers-heading">
              <div className="mb-2 flex items-center gap-2">
                <ArrowsOutLineHorizontal size={18} aria-hidden="true" />
                <h3 id="numbers-heading" className="text-[13px] font-semibold">
                  Number grouping
                </h3>
              </div>
              <Choice
                preference="numberGrouping"
                options={[
                  {
                    value: "indian",
                    label: "Indian",
                    detail: "1,23,45,678.00",
                  },
                  {
                    value: "international",
                    label: "International",
                    detail: "12,345,678.00",
                  },
                ]}
              />
            </section>
          </div>
        </Panel>

        <div className="space-y-5">
          <Panel className="overflow-hidden">
            <div className="border-b border-line px-5 py-4">
              <h3 className="text-[13px] font-semibold">
                Live reading preview
              </h3>
              <p className="mt-1 text-[11px] text-muted">
                This panel uses the active device preferences.
              </p>
            </div>
            <div className="p-5">
              <p className="text-[15px] font-semibold">Sales register</p>
              <p className="mt-1 max-w-[38ch] leading-6 text-muted">
                Review taxable value, tax and closing balance with clear labels
                at every size.
              </p>
              <div className="mt-5 grid grid-cols-2 gap-4 border-t border-line pt-4">
                <div>
                  <span className="block text-[10px] uppercase tracking-[0.08em] text-muted">
                    Taxable value
                  </span>
                  <strong className="num mt-1 block">
                    {formatPaise(1234567890, { grouping: numberGrouping })}
                  </strong>
                </div>
                <div>
                  <span className="block text-[10px] uppercase tracking-[0.08em] text-muted">
                    Status
                  </span>
                  <strong className="mt-1 block">✓ Ready to review</strong>
                </div>
              </div>
            </div>
          </Panel>

          {guidance && (
            <Panel className="p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-[13px] font-semibold">Local guidance</h3>
                  <p className="mt-1 text-[11px] text-muted">
                    {guidance.stateName}. {guidance.registrationLabel}.
                  </p>
                </div>
                <span className="num rounded border border-line bg-panel2 px-2 py-1 text-[10px]">
                  State {info?.stateCode}
                </span>
              </div>
              <div className="mt-4 space-y-3 text-[11.5px] leading-5 text-muted">
                <p>
                  <strong className="text-ink">GST:</strong> {guidance.gst}
                </p>
                <p>
                  <strong className="text-ink">Payroll:</strong>{" "}
                  {guidance.payroll}
                </p>
                <p>
                  <strong className="text-ink">Invoices:</strong>{" "}
                  {guidance.invoice}
                </p>
              </div>
              <p className="mt-4 border-t border-line pt-3 text-[10.5px] text-muted">
                Guidance is contextual only. It never changes calculations or
                filing data.
              </p>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}
