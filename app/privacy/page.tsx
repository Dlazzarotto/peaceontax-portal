// app/privacy/page.tsx — PÚBLICA (sem login)
// Exigida pelo registro A2P 10DLC: as operadoras abrem este link para
// verificar a seção de mensagens de texto antes de aprovar a campanha.

export const metadata = {
  title: 'Privacy Policy — Peace on Tax Corp',
  description: 'How Peace on Tax Corp collects, uses and protects client information, including SMS messaging.',
}

const FIRM = {
  name: 'Peace on Tax Corp',
  address: '75 Pleasant St Suite 119, Malden, MA 02148',
  phone: '(833) 732-2327',
  sms: '(857) 837-2327',
  email: 'info@peaceontax.com',
}

export default function PrivacyPage() {
  const atualizado = 'August 2026'
  const h2: React.CSSProperties = { fontSize: 17, fontWeight: 700, margin: '28px 0 8px', color: '#0F2340' }
  const p: React.CSSProperties = { margin: '10px 0', lineHeight: 1.7 }

  return (
    <main style={{ fontFamily: 'Georgia, "Times New Roman", serif', maxWidth: 780, margin: '0 auto',
      padding: '40px 24px 60px', color: '#1a2a3a', fontSize: 15 }}>

      <header style={{ borderBottom: '2px solid #0F2340', paddingBottom: 14, marginBottom: 8 }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: '#0F2340' }}>{FIRM.name}</div>
        <div style={{ fontSize: 13, color: '#5a6a7a' }}>
          {FIRM.address} · {FIRM.phone} · {FIRM.email}
        </div>
      </header>

      <h1 style={{ fontSize: 26, margin: '22px 0 4px', color: '#0F2340' }}>Privacy Policy</h1>
      <div style={{ fontSize: 13, color: '#5a6a7a', marginBottom: 18 }}>Last updated: {atualizado}</div>

      <p style={p}>
        {FIRM.name} (&quot;we&quot;, &quot;us&quot;) provides tax preparation, bookkeeping and business
        advisory services. This policy explains what information we collect, how we use it, and the
        choices you have. We are also bound by professional confidentiality rules applicable to tax
        practitioners, including IRC §7216 governing the use of tax return information.
      </p>

      <h2 style={h2}>Information we collect</h2>
      <p style={p}>
        Identification and contact details (name, address, email, phone number); tax and financial
        information you provide or authorize us to obtain (documents, bank statements, payroll data);
        business records needed to perform bookkeeping; and payment information processed by our
        payment provider. We do not store full credit or debit card numbers on our systems.
      </p>

      <h2 style={h2}>How we use information</h2>
      <p style={p}>
        To prepare returns and financial statements, to communicate about your engagement, to bill and
        collect for services, to comply with legal and regulatory obligations, and to protect against
        fraud. We do not use tax return information for any purpose other than the services you
        engaged us for, unless you give separate written consent as required by IRC §7216.
      </p>

      <h2 style={h2}>SMS and text messaging</h2>
      <p style={p}>
        With your consent, we send text messages related to your services — such as advance notice of
        a scheduled charge, payment confirmation, failed payment alerts, document requests and
        availability of your reports. Message frequency varies. <strong>Message and data rates may
        apply.</strong>
      </p>
      <p style={p}>
        You may opt out at any time by replying <strong>STOP</strong> to any message; you will receive
        a confirmation and no further messages. Reply <strong>START</strong> to resume, or{' '}
        <strong>HELP</strong> for assistance. You may also call us at {FIRM.phone}.
      </p>
      <p style={{ ...p, fontWeight: 700 }}>
        We do not sell, rent or share mobile phone numbers or SMS consent with third parties or
        affiliates for their marketing purposes. Text messaging originator opt-in data and consent are
        not shared with any third party except the messaging provider strictly necessary to deliver
        the messages.
      </p>
      <p style={p}>
        Our messaging number is {FIRM.sms}. Opting out of text messages does not affect email or phone
        communication about your engagement.
      </p>

      <h2 style={h2}>How we share information</h2>
      <p style={p}>
        We share information only with service providers that help us operate — such as secure hosting,
        electronic signature, payment processing and messaging — under agreements requiring them to
        protect it; with tax authorities when filing on your behalf and with your authorization; and
        when required by law. <strong>We never sell your information.</strong>
      </p>

      <h2 style={h2}>Security</h2>
      <p style={p}>
        We maintain a written information security program, as required of tax professionals, with
        encrypted transmission and storage, access limited to personnel who need it, and multi-factor
        authentication on administrative systems.
      </p>

      <h2 style={h2}>Retention</h2>
      <p style={p}>
        We retain records for the period required by professional and legal standards — generally
        seven years for tax records — and dispose of them securely afterwards.
      </p>

      <h2 style={h2}>Your choices</h2>
      <p style={p}>
        You may request a copy of the information we hold about you, ask for corrections, withdraw SMS
        consent, or request deletion of information we are not legally required to keep. Contact us at{' '}
        {FIRM.email} or {FIRM.phone}.
      </p>

      <h2 style={h2}>Changes</h2>
      <p style={p}>
        We may update this policy; the date above reflects the current version. Material changes will
        be communicated to active clients.
      </p>

      <h2 style={h2}>Contact</h2>
      <p style={p}>
        {FIRM.name}<br />
        {FIRM.address}<br />
        Phone: {FIRM.phone} · Text: {FIRM.sms} · {FIRM.email}
      </p>

      <footer style={{ marginTop: 34, paddingTop: 12, borderTop: '1px solid #d8dee8',
        fontSize: 12.5, color: '#5a6a7a' }}>
        See also our <a href="/terms" style={{ color: '#2D3278' }}>Terms of Service</a>.
      </footer>
    </main>
  )
}
