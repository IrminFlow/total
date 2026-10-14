// WP 10.3: the help panel's state — open or not, which article, what was searched. Opened with
// ? / ⌘/ (App.tsx), the simple header's Help button, an empty state's "Learn how" or an Ask
// Total answer. `follow` = the article is the current screen's (opened by key / button), so it
// follows the user to the next screen; picking an article stops that.
import { create } from 'zustand'
import type { HelpArticleId } from './articles'

interface HelpStore {
  open: boolean
  article: HelpArticleId | null
  follow: boolean
  query: string
  /** Open on the current screen's article (`contextId`) — it follows navigation. */
  openForScreen: (contextId: HelpArticleId) => void
  /** Open on one article (a "Learn how" link, a search hit, a link in an article). */
  openArticle: (id: HelpArticleId) => void
  /** The list of every article (and the search box). */
  openList: () => void
  toggleForScreen: (contextId: HelpArticleId) => void
  setQuery: (q: string) => void
  setFollowed: (id: HelpArticleId) => void
  close: () => void
}

export const useHelpPanel = create<HelpStore>((set, get) => ({
  open: false,
  article: null,
  follow: false,
  query: '',
  openForScreen: (contextId) => set({ open: true, article: contextId, follow: true, query: '' }),
  openArticle: (id) => set({ open: true, article: id, follow: false, query: '' }),
  openList: () => set({ open: true, article: null, follow: false }),
  toggleForScreen: (contextId) => (get().open ? get().close() : get().openForScreen(contextId)),
  setQuery: (query) => set({ query }),
  setFollowed: (id) => set((s) => (s.follow && s.article !== id ? { article: id } : s)),
  close: () => set({ open: false, query: '' })
}))
