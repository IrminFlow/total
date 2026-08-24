import { useEffect, useRef, useState } from "react";
import { Lightbulb, X } from "@phosphor-icons/react";
import {
  dismissDiscovery,
  visitForDiscovery,
  type DiscoveryTip,
} from "../lib/productEducation";
import { readProductFlags } from "../lib/productFlags";

export function FeatureDiscovery({ screen }: { screen: string }): React.JSX.Element | null {
  const [tip, setTip] = useState<DiscoveryTip | null>(null);
  const recordedScreen = useRef<string | null>(null);

  useEffect(() => {
    if (recordedScreen.current === screen) return;
    recordedScreen.current = screen;
    setTip(visitForDiscovery(localStorage, screen));
  }, [screen]);

  if (!readProductFlags(localStorage).flags.featureDiscovery || !tip) return null;
  return (
    <aside
      data-testid="feature-discovery"
      aria-label="Feature tip"
      className="fixed right-5 top-[76px] z-30 w-[330px] rounded-lg border border-amber/35 bg-panel p-4 shadow-xl"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-amber/30 bg-amber/10 text-amber-deep">
          <Lightbulb size={17} weight="fill" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-amber-deep">
            Useful here
          </p>
          <p className="mt-1 text-[12px] font-semibold text-ink">{tip.title}</p>
          <p className="mt-1 text-[10.5px] leading-4 text-muted">{tip.detail}</p>
        </div>
        <button
          aria-label="Dismiss feature tip"
          className="rounded p-1 text-muted hover:bg-panel2 hover:text-ink"
          onClick={() => {
            dismissDiscovery(localStorage, tip.id, false);
            setTip(null);
          }}
        >
          <X size={14} />
        </button>
      </div>
      <div className="mt-3 flex items-center justify-end gap-3 border-t border-line pt-2.5">
        <button
          className="text-[10.5px] text-muted hover:text-ink"
          onClick={() => {
            dismissDiscovery(localStorage, tip.id, true);
            setTip(null);
          }}
        >
          Never show this tip
        </button>
        <button
          className="rounded border border-line bg-panel2 px-2.5 py-1 text-[10.5px] font-medium text-ink hover:border-amber/50"
          onClick={() => {
            dismissDiscovery(localStorage, tip.id, false);
            setTip(null);
          }}
        >
          Got it
        </button>
      </div>
    </aside>
  );
}
