import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Peace on Tax — Client Portal',
  description: 'Secure accounting and tax portal — Massachusetts',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
