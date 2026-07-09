// /privacy — Privacy Policy pública (exigida para Plaid, GLBA e boas práticas)
// Página estática, acessível sem login.

export const metadata = { title: 'Privacy Policy — Peace on Tax Corp' }

const FIRM = {
  name: 'Peace on Tax Corp',
  address: '75 Pleasant St Suite 119, Malden, MA 02148',
  phone: '(833) 732-2327',
  email: 'info@peaceontax.com',
}

export default function PrivacyPage() {
  const s = {
    h2: { fontFamily: 'Georgia,serif', fontSize: 18, color: '#2D3278', margin: '28px 0 10px' } as const,
    p: { fontSize: 15, lineHeight: 1.8, color: '#2a3a4a', margin: '0 0 12px' } as const,
    li: { fontSize: 15, lineHeight: 1.8, color: '#2a3a4a', marginBottom: 6 } as const,
  }
  return (
    <div style={{ background: '#f7f9fc', minHeight: '100vh', padding: '32px 16px' }}>
      <div style={{ maxWidth: 780, margin: '0 auto', background: '#fff', borderRadius: 16, padding: '44px 48px', boxShadow: '0 2px 24px rgba(45,50,120,0.08)' }}>
        <img src="/logo.png" alt={FIRM.name} style={{ height: 52, marginBottom: 18 }} />
        <h1 style={{ fontFamily: 'Georgia,serif', fontSize: 26, color: '#0f2340', margin: '0 0 4px' }}>Privacy Policy</h1>
        <p style={{ fontSize: 13, color: '#8a9ab0', margin: '0 0 24px' }}>Last updated: July 8, 2026 · <a href="/privacidade" style={{ color: '#F47B20' }}>Versão em Português</a></p>

        <p style={s.p}><b>{FIRM.name}</b> ("we", "us") provides tax preparation, accounting, and bookkeeping services. This policy describes how we collect, use, protect, and share your information when you use our client portal and services.</p>

        <h2 style={s.h2}>Information We Collect</h2>
        <ul style={{ paddingLeft: 22 }}>
          <li style={s.li}><b>Identity and contact data</b> — name, email, phone, address, date of birth, SSN/ITIN/EIN, provided by you for tax and accounting services.</li>
          <li style={s.li}><b>Tax and financial documents</b> — documents you upload to the portal (W-2s, 1099s, statements, receipts).</li>
          <li style={s.li}><b>Bank account and transaction data</b> — when you choose to connect a bank account through <b>Plaid Inc.</b>, we receive account and transaction information for bookkeeping purposes. Plaid's own privacy policy is available at <a href="https://plaid.com/legal/#end-user-privacy-policy" style={{ color: '#F47B20' }}>plaid.com/legal</a>. We do not receive or store your bank login credentials.</li>
          <li style={s.li}><b>Payment data</b> — payments are processed by <b>Stripe</b>; we do not store full card or bank account numbers on our servers.</li>
          <li style={s.li}><b>Usage data</b> — login activity and actions in the portal, kept for security and audit purposes.</li>
        </ul>

        <h2 style={s.h2}>How We Use Your Information</h2>
        <ul style={{ paddingLeft: 22 }}>
          <li style={s.li}>To prepare tax returns and provide accounting, bookkeeping, and advisory services you request;</li>
          <li style={s.li}>To categorize financial transactions and produce reports (e.g., Profit &amp; Loss) as part of bookkeeping engagements;</li>
          <li style={s.li}>To process payments, send invoices, contracts, and e-signature requests;</li>
          <li style={s.li}>To communicate with you about your services;</li>
          <li style={s.li}>To meet legal and regulatory obligations (IRS, state authorities).</li>
        </ul>

        <h2 style={s.h2}>What We Do NOT Do</h2>
        <ul style={{ paddingLeft: 22 }}>
          <li style={s.li}>We do <b>not</b> sell your personal information;</li>
          <li style={s.li}>We do <b>not</b> use or disclose tax return information except as permitted by IRC §7216 (with your consent or as required by law);</li>
          <li style={s.li}>We do <b>not</b> share your data with third parties for their marketing.</li>
        </ul>

        <h2 style={s.h2}>How We Protect Your Information</h2>
        <p style={s.p}>All data is encrypted in transit (TLS 1.2+) and at rest (AES-256). Access is restricted by role-based permissions; sensitive actions are logged in audit trails. Our security program follows the FTC Safeguards Rule and IRS Publication 4557 guidelines applicable to tax professionals.</p>

        <h2 style={s.h2}>Service Providers</h2>
        <p style={s.p}>We use vetted service providers to operate the portal: Supabase (secure data hosting), Vercel (application hosting), Stripe (payments), DocuSign (e-signatures), Plaid (bank connections, at your election), Resend (transactional email), and Anthropic (document classification assistance). Providers process data only as needed to deliver our services.</p>

        <h2 style={s.h2}>Data Retention</h2>
        <p style={s.p}>We retain tax records for the periods required by federal and state law (generally at least 3–7 years). You may request a copy of your documents at any time.</p>

        <h2 style={s.h2}>Your Choices and Rights</h2>
        <ul style={{ paddingLeft: 22 }}>
          <li style={s.li}>You may disconnect a linked bank account at any time from the portal or by contacting us;</li>
          <li style={s.li}>You may request access to, correction of, or (where legally permissible) deletion of your information;</li>
          <li style={s.li}>You may direct how your tax return information is used or disclosed under IRC §7216.</li>
        </ul>

        <h2 style={s.h2}>Contact Us</h2>
        <p style={s.p}>
          {FIRM.name}<br />
          {FIRM.address}<br />
          {FIRM.phone} · <a href={`mailto:${FIRM.email}`} style={{ color: '#F47B20' }}>{FIRM.email}</a>
        </p>
      </div>
    </div>
  )
}
