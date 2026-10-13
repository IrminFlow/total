// WP 8.4: the small line icons the plain pickers show next to account kinds and categories
// (categories.ts / accountKinds.ts `icon` ids). 24×24 strokes, currentColor — they follow the
// theme tokens of whatever text they sit in. Decorative: hidden from screen readers (the label
// next to each icon names it).

const PATHS: Record<string, readonly string[]> = {
  cart: ['M3 4h2l2.4 10.2a1 1 0 0 0 1 .8h8.9a1 1 0 0 0 1-.8L20 8H6.2', 'M9 20h.01', 'M17 20h.01'],
  briefcase: ['M4 8h16v11H4z', 'M9 8V5h6v3', 'M4 13h16'],
  box: ['M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z', 'M3 7.5 12 12l9-4.5', 'M12 12v9'],
  layers: ['M12 3 3 8l9 5 9-5z', 'm3 13 9 5 9-5', 'm3 17.5 9 4.5 9-4.5'],
  truck: ['M2 6h12v10H2z', 'M14 10h4l4 3v3h-8', 'M6 19a1.5 1.5 0 1 0 0-.01', 'M18 19a1.5 1.5 0 1 0 0-.01'],
  hammer: ['m14 6 4 4', 'M12 4l6 6-2 2-6-6z', 'M10 8 3 15l3 3 7-7'],
  bolt: ['M13 2 4 14h7l-1 8 9-12h-7z'],
  flame: ['M12 22a6 6 0 0 0 6-6c0-4-3-6-4-10-2 2-3 4-3 6-1-1-2-2-2-4-2 2-3 5-3 8a6 6 0 0 0 6 6z'],
  utensils: ['M7 2v20', 'M4 2v6a3 3 0 0 0 6 0V2', 'M17 2c-2 2-3 5-3 8h3v12'],
  home: ['M3 11 12 4l9 7', 'M5 10v10h14V10', 'M10 20v-6h4v6'],
  users: ['M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M2 21a7 7 0 0 1 14 0', 'M16 3.5a4 4 0 0 1 0 7', 'M18 14a7 7 0 0 1 4 7'],
  phone: ['M7 2h10v20H7z', 'M11 18h2'],
  bank: ['M3 10 12 4l9 6', 'M4 10h16', 'M6 10v8', 'M10 10v8', 'M14 10v8', 'M18 10v8', 'M3 20h18'],
  wrench: ['M14.7 6.3a4 4 0 0 0 5 5L21 13l-8 8-3-3 1.3-1.3a4 4 0 0 0-5-5L3 10l3-3z'],
  paperclip: ['M21 11 12 20a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8'],
  package: ['M4 7h16v13H4z', 'M3 4h18v3H3z', 'M10 11h4'],
  shop: ['M4 9 5 4h14l1 5', 'M4 9h16v11H4z', 'M9 20v-6h6v6'],
  percent: ['M19 5 5 19', 'M6.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z', 'M17.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z'],
  laptop: ['M5 5h14v10H5z', 'M2 19h20'],
  plane: ['M2 13l20-8-6 16-3-7z', 'M13 14 22 5'],
  scale: ['M12 3v18', 'M5 7h14', 'M5 7l-3 7a3 3 0 0 0 6 0z', 'M19 7l-3 7a3 3 0 0 0 6 0z', 'M8 21h8'],
  bike: ['M5.5 17.5a3.5 3.5 0 1 0 0-.01', 'M18.5 17.5a3.5 3.5 0 1 0 0-.01', 'M5.5 17.5 9 9h5l4.5 8.5', 'M12 9l-1-3h-2'],
  tag: ['M3 3h8l10 10-8 8L3 11z', 'M7.5 7.5h.01'],
  wallet: ['M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H3z', 'M3 7l12-3v3', 'M16 13.5h.01'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  receipt: ['M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z', 'M9 8h6', 'M9 12h6'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'm20 20-4-4'],
  plus: ['M12 5v14', 'M5 12h14'],
  more: ['M5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z', 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z', 'M19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z'],
  dot: ['M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z']
}

const ROUND = { strokeLinecap: 'round', strokeLinejoin: 'round' } as const // i18n-technical: SVG attributes

export function PlainIcon({ id, className }: { id: string; className?: string }): React.JSX.Element {
  const paths = PATHS[id] ?? PATHS.dot!
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      {...ROUND}
      aria-hidden="true"
      className={className}
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}
