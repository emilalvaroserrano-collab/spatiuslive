import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Kimmy — Realtime Live Seller',
  description: 'Spatius Nadia avatar driven by Gemini Live as Kimmy, a realtime Filipina live seller.',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>
}
