/** ⌘⇧F on the Search results screen focuses its query box (App.tsx dispatches, SearchResults listens).
 *  Kept outside the screen so App.tsx does not have to load the screen's chunk for a constant. */
export const FOCUS_SEARCH_EVENT = 'total:focus-search'
