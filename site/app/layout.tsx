import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Serif, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import SiteFooter from "@/components/SiteFooter";

const sans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-sans",
});
const serif = IBM_Plex_Serif({
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-serif",
});
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ?? "https://devjindal.tech",
  ),
  title: {
    default: "Total | Private accounting for macOS and Windows",
    template: "%s | Total",
  },
  description:
    "Tally-grade double-entry accounting for macOS and Windows. GST, invoices, stock, banking, payroll and optional AI, offline-first in a folder you own.",
  openGraph: {
    title: "Total | Private accounting for macOS and Windows",
    description: "Your books. On this Mac. Nowhere else.",
    images: [
      {
        url: "/gateway-light.jpg",
        width: 1440,
        height: 900,
        alt: "Total accounting Gateway",
      },
    ],
    type: "website",
    locale: "en_IN",
    siteName: "Total",
  },
  twitter: {
    card: "summary_large_image",
    title: "Total | Private accounting for macOS and Windows",
    description:
      "Offline-first accounting, GST, inventory, banking and payroll for Indian businesses.",
    images: ["/gateway-light.jpg"],
  },
  applicationName: "Total",
  category: "business",
};

const softwareApplication = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Total",
  applicationCategory: "BusinessApplication",
  operatingSystem: "macOS, Windows",
  description:
    "Offline-first double-entry accounting, GST, inventory, banking and payroll for Indian businesses.",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "INR",
    description: "Free during the public beta",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${serif.variable} ${mono.variable}`}
    >
      <body>
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        {children}
        <SiteFooter />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(softwareApplication).replaceAll(
              "<",
              "\\u003c",
            ),
          }}
        />
      </body>
    </html>
  );
}
