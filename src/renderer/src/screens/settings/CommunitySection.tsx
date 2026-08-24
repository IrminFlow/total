import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Certificate,
  CheckCircle,
  GraduationCap,
  Heart,
  Lightbulb,
  UsersThree,
} from "@phosphor-icons/react";
import { api, type FeedbackIdea } from "../../lib/client";
import {
  certificationProgress,
  cohortPayload,
  LEARNING_MODULES,
  readCommercialState,
  validReferralCode,
  writeCommercialState,
  type CommercialState,
} from "../../lib/commercialOps";
import { useToasts } from "../../state/stores";
import { Button, Panel, SectionTitle } from "../../components/ui";
import { readProductFlags } from "../../lib/productFlags";

const STATUS_LABEL: Record<FeedbackIdea["status"], string> = {
  considering: "Considering",
  planned: "Planned",
  building: "Building",
  released: "Released",
};

export function CommunitySection(): React.JSX.Element {
  const toast = useToasts();
  const queryClient = useQueryClient();
  const [state, setState] = useState<CommercialState>(() =>
    readCommercialState(localStorage),
  );
  const [appInfo, setAppInfo] = useState({ version: "—", platform: "—" });
  const [ideaTitle, setIdeaTitle] = useState("");
  const [ideaDetail, setIdeaDetail] = useState("");
  const [ideaEmail, setIdeaEmail] = useState("");
  const [referralInput, setReferralInput] = useState("");
  const [sending, setSending] = useState(false);
  const [training, setTraining] = useState(false);
  const board = useQuery({
    queryKey: ["communityIdeas"],
    queryFn: api.community.ideas,
  });
  const companies = useQuery({ queryKey: ["registry"], queryFn: api.company.list });
  const progress = certificationProgress(state);
  const workspaceEnabled = readProductFlags(localStorage).flags.communityWorkspace;
  const preview = useMemo(
    () => cohortPayload(state, appInfo.version, appInfo.platform),
    [state, appInfo],
  );

  useEffect(() => {
    void api.app.info().then(setAppInfo);
  }, []);

  const save = (next: CommercialState): void => {
    writeCommercialState(localStorage, next);
    setState({ ...next });
  };

  const submitIdea = async (): Promise<void> => {
    setSending(true);
    try {
      const result = await api.community.submitIdea(
        ideaTitle,
        ideaDetail,
        ideaEmail,
      );
      setIdeaTitle("");
      setIdeaDetail("");
      toast.push("success", `Idea submitted · ${result.ideaId}`);
      await queryClient.invalidateQueries({ queryKey: ["communityIdeas"] });
    } catch (error) {
      toast.push("error", (error as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div data-testid="community-settings">
      <SectionTitle>Community, learning & plan</SectionTitle>
      {!workspaceEnabled && (
        <Panel className="mb-4 border-amber/30 bg-amber/5 px-4 py-3 text-[10.5px] text-muted">
          This optional workspace is disabled by the device rollout flag. Core
          books, permanent export and Support are unchanged. Re-enable it from
          Settings → About, then reopen Total.
        </Panel>
      )}
      <Panel className="overflow-hidden">
        <div className="grid grid-cols-[1fr_220px] gap-5 border-b border-line bg-panel2 p-5">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-deep">
              Founding edition · public preview
            </p>
            <h3 className="mt-1 font-serif text-[21px] font-semibold text-ink">
              ₹0 during the public preview. Your books are never held hostage.
            </h3>
            <p className="mt-2 max-w-2xl text-[11.5px] leading-5 text-muted">
              If paid plans are introduced, pricing and included features will be
              shown before activation with at least 60 days notice. Core book
              access and complete portable export remain available even if a
              future entitlement expires.
            </p>
          </div>
          <div className="rounded-md border border-dr/30 bg-dr/5 p-3">
            <p className="flex items-center gap-2 text-[11.5px] font-medium text-dr">
              <CheckCircle size={16} weight="fill" /> Local entitlement
            </p>
            <p className="mt-2 text-[10.5px] leading-4 text-muted">
              Active · no sign-in required
              <br />Offline grace · unlimited in preview
              <br />Permanent data export · included
            </p>
          </div>
        </div>
      </Panel>

      <div className="mt-4 grid grid-cols-2 gap-4">
        <Panel className="p-4">
          <p className="flex items-center gap-2 text-[12px] font-semibold text-ink">
            <Lightbulb size={17} weight="fill" className="text-amber-deep" />
            Customer idea board
          </p>
          <p className="mt-1 text-[10.5px] leading-4 text-muted">
            Submit, vote and follow progress. Released ideas link to the version
            that shipped them; no accounting data is attached.
          </p>
          <div className="mt-3 max-h-56 space-y-2 overflow-y-auto">
            {board.data?.map((idea) => (
              <div key={idea.id} className="rounded-md border border-line bg-panel2 px-3 py-2.5">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-[11.5px] font-medium text-ink">{idea.title}</p>
                    <p className="mt-0.5 text-[10px] leading-4 text-muted">{idea.detail}</p>
                  </div>
                  <span className="shrink-0 rounded border border-line bg-panel px-1.5 py-0.5 text-[9px] font-medium text-muted">
                    {STATUS_LABEL[idea.status]}
                    {idea.releaseVersion ? ` · v${idea.releaseVersion}` : ""}
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    className="rounded border border-line bg-panel px-2 py-1 text-[9.5px] text-muted hover:text-ink"
                    onClick={() =>
                      void api.community
                        .vote(idea.id)
                        .then(() => toast.push("success", "Vote counted"))
                        .catch((error: Error) => toast.push("error", error.message))
                    }
                  >
                    △ {idea.votes} vote{idea.votes === 1 ? "" : "s"}
                  </button>
                  <button
                    className="rounded border border-line bg-panel px-2 py-1 text-[9.5px] text-muted hover:text-ink"
                    onClick={() =>
                      void api.community
                        .follow(idea.id)
                        .then(() => {
                          const next = { ...state, followedIdeas: [...new Set([...state.followedIdeas, idea.id])] };
                          save(next);
                          toast.push("success", "Following release updates");
                        })
                        .catch((error: Error) => toast.push("error", error.message))
                    }
                  >
                    {state.followedIdeas.includes(idea.id) ? "Following" : "Follow"}
                  </button>
                </div>
              </div>
            ))}
            {board.isError && (
              <p className="rounded border border-dashed border-line px-3 py-4 text-center text-[10.5px] text-muted">
                The live idea board needs internet. You can still draft an idea
                here or use Support.
              </p>
            )}
          </div>
          <div className="mt-3 grid gap-2 border-t border-line pt-3">
            <input value={ideaTitle} maxLength={120} onChange={(event) => setIdeaTitle(event.target.value)} placeholder="Idea title" className="rounded border border-line bg-panel2 px-2.5 py-2 text-[11px] text-ink" />
            <textarea value={ideaDetail} maxLength={2000} onChange={(event) => setIdeaDetail(event.target.value)} placeholder="What job would this improve?" className="min-h-20 resize-y rounded border border-line bg-panel2 px-2.5 py-2 text-[11px] text-ink" />
            <div className="flex gap-2"><input value={ideaEmail} onChange={(event) => setIdeaEmail(event.target.value)} type="email" placeholder="Email for updates (optional)" className="min-w-0 flex-1 rounded border border-line bg-panel2 px-2.5 py-2 text-[11px] text-ink" /><Button disabled={sending || ideaTitle.trim().length < 5 || ideaDetail.trim().length < 10} onClick={() => void submitIdea()}>{sending ? "Sending…" : "Submit idea"}</Button></div>
          </div>
        </Panel>

        <Panel className="p-4">
          <p className="flex items-center gap-2 text-[12px] font-semibold text-ink">
            <Heart size={17} weight="fill" className="text-cr" /> Privacy-first product insights
          </p>
          <p className="mt-1 text-[10.5px] leading-4 text-muted">
            Opt in to aggregate activation and return milestones. Never includes
            company identity, amounts, ledgers, vouchers, filenames or user text.
          </p>
          <label className="mt-3 flex items-start gap-2 rounded-md border border-line bg-panel2 px-3 py-2.5 text-[11px] text-muted">
            <input
              type="checkbox"
              checked={state.analytics.enabled}
              onChange={(event) => {
                const next = { ...state, analytics: { ...state.analytics, enabled: event.target.checked } };
                save(next);
              }}
            />
            Share this bounded aggregate envelope only when I choose Send.
          </label>
          <div className="mt-2 overflow-hidden rounded-md border border-line">
            <p className="border-b border-line bg-panel2 px-2.5 py-1.5 text-[10px] font-medium text-ink">Exact payload preview</p>
            <pre className="num max-h-40 overflow-auto bg-panel px-2.5 py-2 text-[9px] leading-4 text-muted">{JSON.stringify(preview, null, 2)}</pre>
          </div>
          <Button
            className="mt-2"
            disabled={!state.analytics.enabled}
            onClick={() =>
              void api.community
                .submitCohort(preview)
                .then(() => toast.push("success", "Aggregate product insight sent"))
                .catch((error: Error) => toast.push("error", error.message))
            }
          >
            Send this payload
          </Button>

          <div className="mt-4 border-t border-line pt-3">
            <p className="text-[11.5px] font-medium text-ink">Offline referral code</p>
            <p className="num mt-1 inline-block rounded border border-amber/30 bg-amber/8 px-2 py-1 text-[12px] font-semibold tracking-wide text-ink">{state.referral.ownCode}</p>
            <p className="mt-1 text-[10px] leading-4 text-muted">The code can be shared or entered without keeping Total online. It contains no name, email or company identifier.</p>
            {!state.referral.attributedCode ? (
              <div className="mt-2 flex gap-2"><input value={referralInput} onChange={(event) => setReferralInput(event.target.value.toUpperCase())} placeholder="TOTAL-XXXXXXXX-XX" className="min-w-0 flex-1 rounded border border-line bg-panel2 px-2.5 py-1.5 text-[10.5px] text-ink" /><Button disabled={!validReferralCode(referralInput)} onClick={() => { const next = { ...state, referral: { ...state.referral, attributedCode: referralInput.trim(), attributedAt: new Date().toISOString() } }; save(next); toast.push("success", "Referral saved on this device"); }}>Apply</Button></div>
            ) : <p className="num mt-2 text-[10px] text-dr">Attributed to {state.referral.attributedCode}</p>}
          </div>
        </Panel>
      </div>

      <Panel className="mt-4 p-4">
        <div className="flex items-start justify-between gap-4">
          <div><p className="flex items-center gap-2 text-[12px] font-semibold text-ink"><UsersThree size={18} /> Accountant partner mode</p><p className="mt-1 text-[10.5px] leading-4 text-muted">Organise many local client books without merging them. Each company retains its own database, backups, users, audit trail and export folder.</p></div>
          <Button onClick={() => save({ ...state, partner: { ...state.partner, enabled: !state.partner.enabled } })}>{state.partner.enabled ? "Turn off partner mode" : "Turn on partner mode"}</Button>
        </div>
        {state.partner.enabled && (
          <div className="mt-3 grid grid-cols-2 gap-2">
            {companies.data?.companies.map((company) => (
              <label key={company.slug} className="rounded-md border border-line bg-panel2 p-3 text-[10.5px] text-muted"><span className="block font-medium text-ink">{company.name}</span><span className="num mt-0.5 block text-[9px]">companies/{company.slug}/ · isolated</span><input value={state.partner.labels[company.slug] ?? ""} onChange={(event) => save({ ...state, partner: { ...state.partner, labels: { ...state.partner.labels, [company.slug]: event.target.value.slice(0, 60) } } })} placeholder="Client group / partner note" className="mt-2 w-full rounded border border-line bg-panel px-2 py-1.5 text-[10.5px] text-ink" /></label>
            ))}
          </div>
        )}
      </Panel>

      <Panel className="mt-4 p-4">
        <div className="flex items-start justify-between gap-4">
          <div><p className="flex items-center gap-2 text-[12px] font-semibold text-ink"><GraduationCap size={18} /> Total practitioner pathway</p><p className="mt-1 text-[10.5px] leading-4 text-muted">Six practical modules for accountants and implementation partners. Progress is local; checking a module records practice, not a credential.</p></div>
          <div className="text-right"><p className="num text-[18px] font-semibold text-ink">{progress.completed}/{progress.total}</p><p className="text-[9.5px] text-muted">modules practised</p></div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {LEARNING_MODULES.map((module) => {
            const complete = state.learning.completed.includes(module.id);
            return <label key={module.id} className={`rounded-md border p-3 ${complete ? "border-dr/30 bg-dr/5" : "border-line bg-panel2"}`}><span className="flex items-start gap-2"><input type="checkbox" checked={complete} onChange={(event) => { const completed = event.target.checked ? [...new Set([...state.learning.completed, module.id])] : state.learning.completed.filter((id) => id !== module.id); save({ ...state, learning: { ...state.learning, completed } }); }} /><span><span className="block text-[11.5px] font-medium text-ink">{module.title}</span><span className="mt-0.5 block text-[10px] leading-4 text-muted">{module.outcome}</span></span></span><details className="mt-2 pl-5 text-[9.5px] leading-4 text-muted"><summary className="cursor-pointer font-medium text-ink">Practice brief</summary><p className="mt-1"><strong>Exercise:</strong> {module.exercise}</p><p><strong>Evidence:</strong> {module.evidence}</p></details></label>;
          })}
        </div>
        <div className="mt-3 flex items-center justify-between rounded-md border border-line bg-panel2 px-3 py-2.5">
          <p className="flex items-center gap-2 text-[10.5px] text-muted"><Certificate size={17} /> {progress.eligible ? "All practice modules complete. A proctored certification assessment can now be booked through Support." : "Complete all practice modules before requesting the proctored certification assessment."}</p>
          <Button disabled={training} onClick={async () => { setTraining(true); try { await api.company.createDemo(); await queryClient.invalidateQueries({ queryKey: ["registry"] }); const next = { ...state, learning: { ...state.learning, freshTrainingCompanies: state.learning.freshTrainingCompanies + 1 } }; save(next); toast.push("success", "Fresh, resettable training company created"); } catch (error) { toast.push("error", (error as Error).message); } finally { setTraining(false); } }}>{training ? "Creating…" : "Create fresh training company"}</Button>
        </div>
      </Panel>
    </div>
  );
}
