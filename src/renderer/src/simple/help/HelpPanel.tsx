// WP 10.3 — the help panel (plan §5): offline articles (help/en/*.md, bundled at build time) in a
// DockedDrawer beside the screen, like Ask Total. Opened with ? (no box focused) or ⌘/ (App.tsx),
// the simple header's Help button, an empty state's "Learn how" or an Ask Total answer; it opens
// on the current screen's article (registry `helpKey`) and follows the user from screen to screen
// until they pick another article. Search covers every article's title and body (English and
// Hindi). Links go to screens (total://screen/…), other articles (total://help/…) or — only — the
// GST portal / CBIC, opened in the browser through main. Simple mode only; it and Ask Total never
// show together.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Language } from '@shared/i18n'
import { api } from '../../lib/client'
import { useLanguage, useT } from '../../lib/i18n'
import { useMode } from '../../lib/mode'
import { helpKeyFor } from '../../lib/screens'
import { useNav, useScreen, useToasts } from '../../state/stores'
import { Button, DockedDrawer, TextInput } from '../../components/kit'
import { useAssistantPanel } from '../../components/ai/AssistantPanel'
import { HELP, type HelpArticle, type HelpArticleId } from '../../help/articles'
import type { HelpLink } from '../../help/links'
import { useHelpPanel } from '../../help/store'
import { useTour } from '../../help/tour'
import { Markdown } from './Markdown'

const WIDTH_KEY = 'total-help-panel' // i18n-technical: localStorage key
const DEFAULT_WIDTH = 420
const HOME = { name: 'gateway' } as const // i18n-technical

function loadWidth(): number {
  try {
    const w = Number(localStorage.getItem(WIDTH_KEY))
    return w >= 340 && w <= 760 ? w : DEFAULT_WIDTH
  } catch {
    return DEFAULT_WIDTH
  }
}

/** The host (Shell): renders the panel while open in a simple company. */
export function HelpPanel(): React.JSX.Element | null {
  const mode = useMode()
  const open = useHelpPanel((s) => s.open)
  const screen = useScreen()
  const aiOpen = useAssistantPanel((s) => s.open)
  const context = helpKeyFor(screen)

  // The article follows the screen while it is the screen's own.
  useEffect(() => {
    useHelpPanel.getState().setFollowed(context)
  }, [context])
  // Help and Ask Total share the right edge: opening one closes the other.
  useEffect(() => {
    if (aiOpen && useHelpPanel.getState().open) useHelpPanel.getState().close()
  }, [aiOpen])
  useEffect(() => {
    if (open && useAssistantPanel.getState().open) useAssistantPanel.getState().setOpen(false)
  }, [open])
  // Switching the company to the full app closes it.
  useEffect(() => {
    if (mode !== 'simple' && useHelpPanel.getState().open) useHelpPanel.getState().close()
  }, [mode])

  if (!open || mode !== 'simple') return null
  return <HelpDrawer context={context} />
}

function HelpDrawer({ context }: { context: HelpArticleId }): React.JSX.Element {
  const t = useT()
  const nav = useNav()
  const toast = useToasts()
  const [lang] = useLanguage()
  const { article: articleId, query, setQuery, openArticle, openList, close } = useHelpPanel()
  const [width, setWidthState] = useState(loadWidth)
  const searchRef = useRef<HTMLInputElement>(null)
  const bodyTop = useRef<HTMLDivElement>(null)
  const setWidth = (w: number): void => {
    setWidthState(w)
    try {
      localStorage.setItem(WIDTH_KEY, String(w))
    } catch {
      /* best effort */
    }
  }
  const language = lang as Language
  const article = articleId ? HELP.article(articleId, language) : null
  const hits = useMemo(() => (query.trim() ? HELP.search(query, language, 10) : []), [query, language])

  useEffect(() => {
    bodyTop.current?.scrollIntoView?.({ block: 'start' })
  }, [articleId])

  const onLink = (link: Exclude<HelpLink, { kind: 'invalid' }>): void => {
    if (link.kind === 'help') openArticle(link.id)
    else if (link.kind === 'screen') nav.go(link.screen)
    else
      api.help.openLink(link.url).catch(() => {
        toast.push('error', t('simple.help.linkFailed'))
      })
  }

  const showTour = (): void => {
    close()
    nav.go(HOME)
    useTour.getState().start()
  }

  const header = (
    <TextInput
      ref={searchRef}
      type="search"
      value={query}
      onChange={(e) => setQuery(e.target.value)}
      placeholder={t('simple.help.searchPlaceholder')}
      aria-label={t('simple.help.search')}
      data-testid="help-search"
    />
  )
  const footer = (
    <div className="flex w-full flex-wrap items-center justify-between gap-2">
      <Button size="sm" variant="ghost" data-testid="help-all" onClick={() => openList()}>
        {t('simple.help.all')}
      </Button>
      <Button size="sm" variant="secondary" data-testid="help-show-tour" onClick={showTour}>
        {t('simple.help.showTour')}
      </Button>
    </div>
  )

  return (
    <DockedDrawer title={t('simple.help.title')} subtitle={t('simple.help.sub')} onClose={close} width={width} onResize={setWidth} testId="help-panel" header={header} footer={footer}>
      <div ref={bodyTop} />
      {query.trim() ? (
        <Hits hits={hits} query={query} onOpen={openArticle} />
      ) : article ? (
        <ArticleView article={article} wanted={language} isContext={article.id === context} onLink={onLink} />
      ) : (
        <ArticleList context={context} onOpen={openArticle} lang={language} />
      )}
    </DockedDrawer>
  )
}

function ArticleView({ article, wanted, isContext, onLink }: { article: HelpArticle; wanted: Language; isContext: boolean; onLink: (l: Exclude<HelpLink, { kind: 'invalid' }>) => void }): React.JSX.Element {
  const t = useT()
  return (
    <article data-testid="help-article" data-article={article.id} aria-labelledby="help-article-title">
      {isContext && <p className="mb-1 text-caption font-semibold tracking-[0.08em] text-muted uppercase">{t('simple.help.forScreen')}</p>}
      <h2 id="help-article-title" className="mb-3 font-serif text-title font-semibold text-ink" data-testid="help-article-title">
        {article.title}
      </h2>
      {wanted === 'hi' && article.lang !== 'hi' && (
        <p className="mb-3 text-hint text-muted" data-testid="help-in-english">
          {t('simple.help.inEnglish')}
        </p>
      )}
      <Markdown blocks={article.blocks} onLink={onLink} />
    </article>
  )
}

function ArticleList({ context, onOpen, lang }: { context: HelpArticleId; onOpen: (id: HelpArticleId) => void; lang: Language }): React.JSX.Element {
  const t = useT()
  const all = HELP.list(lang)
  return (
    <div className="flex flex-col gap-1" data-testid="help-list">
      <h2 className="mb-2 text-label font-semibold tracking-[0.08em] text-muted uppercase">{t('simple.help.all')}</h2>
      {all.map((a) => (
        <button
          key={a.id}
          type="button"
          data-testid="help-list-item"
          data-article={a.id}
          onClick={() => onOpen(a.id)}
          className={`rounded-md border px-3 py-2 text-left hover:border-amber/60 hover:bg-panel2 ${a.id === context ? 'border-amber/50 bg-amber/10' : 'border-transparent'}`}
        >
          <span className="block text-detail font-semibold text-ink">{a.title}</span>
          <span className="line-clamp-2 block text-hint text-muted">{a.summary}</span>
        </button>
      ))}
    </div>
  )
}

function Hits({ hits, query, onOpen }: { hits: { article: HelpArticle; snippet: string }[]; query: string; onOpen: (id: HelpArticleId) => void }): React.JSX.Element {
  const t = useT()
  if (!hits.length) {
    return (
      <p className="text-detail text-muted" data-testid="help-no-hits">
        {t('simple.help.noHits', { q: query.trim() })}
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-1" data-testid="help-hits">
      <p className="mb-1 text-hint text-muted">{t('simple.help.hits', { count: hits.length })}</p>
      {hits.map((h) => (
        <button
          key={h.article.id}
          type="button"
          data-testid="help-hit"
          data-article={h.article.id}
          onClick={() => onOpen(h.article.id)}
          className="rounded-md border border-transparent px-3 py-2 text-left hover:border-amber/60 hover:bg-panel2"
        >
          <span className="block text-detail font-semibold text-ink">{h.article.title}</span>
          <span className="block text-hint text-muted">{h.snippet}</span>
        </button>
      ))}
    </div>
  )
}
