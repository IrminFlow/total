import type { Metadata } from 'next'
import { IBM_Plex_Sans, IBM_Plex_Serif, IBM_Plex_Mono } from 'next/font/google'
import './globals.css'
import SiteFooter from '@/components/SiteFooter'

const sans = IBM_Plex_Sans({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-sans' })
const serif = IBM_Plex_Serif({ subsets: ['latin'], weight: ['600', '700'], variable: '--font-serif' })
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-mono' })

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'https://devjindal.tech'),
  title: 'Total | Private accounting for macOS and Windows',
  description:
    'Tally-grade double-entry accounting for macOS and Windows. GST, invoices, stock, banking, payroll and optional AI, offline-first in a folder you own.',
  openGraph: {
    title: 'Total | Private accounting for macOS and Windows',
    description: 'Your books. On this Mac. Nowhere else.',
    images: ['/gateway-light.jpg']
  }
}

export default function RootLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable} ${mono.variable}`}>
      <body>{children}<SiteFooter /></body>
    </html>
  )
}
