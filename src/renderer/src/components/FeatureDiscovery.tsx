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
      className="mb-2 flex min-h-8 items-center gap-2 rounded-md border border-amber/35 bg-amber/5 px-2.5 py-1.5"
    >
      <Lightbulb size={14} weight="fill" className="shrink-0 text-amber" />
      <p className="min-w-0 flex-1 truncate text-[11.5px] text-ink" title={`${tip.title}. ${tip.detail}`}>
        <span className="font-semibold">{tip.title}</span>
        <span className="feature-tip-detail text-muted">: {tip.detail}</span>
      </p>
      <button
        className="shrink-0 whitespace-nowrap px-1.5 py-1 text-[10.5px] text-muted hover:text-ink"
        onClick={() => {
          dismissDiscovery(localStorage, tip.id, true);
          setTip(null);
        }}
      >
        Never show this tip
      </button>
      <button
        aria-label="Dismiss feature tip"
        title="Dismiss for 30 days"
        className="shrink-0 rounded p-1 text-muted hover:bg-panel2 hover:text-ink"
        onClick={() => {
          dismissDiscovery(localStorage, tip.id, false);
          setTip(null);
        }}
      >
        <X size={14} />
      </button>
    </aside>
  );
}
