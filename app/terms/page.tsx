// app/terms/page.tsx — PÚBLICA (sem login)
// Link exigido no registro da campanha A2P 10DLC.

export const metadata = {
  title: 'Terms of Service — Peace on Tax Corp',
  description: 'Terms governing services and communications provided by Peace on Tax Corp.',
}

const FIRM = {
  name: 'Peace on Tax Corp',
  address: '75 Pleasant St Suite 119, Malden, MA 02148',
  phone: '(833) 732-2327',
  sms: '(857) 837-2327',
  email: 'info@peaceontax.com',
}

export default function TermsPage() {
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

      <h1 style={{ fontSize: 26, margin: '22px 0 4px', color: '#0F2340' }}>Terms of Service</h1>
      <div style={{ fontSize: 13, color: '#5a6a7a', marginBottom: 18 }}>Last updated: {atualizado}</div>

      <h2 style={h2}>1. Services</h2>
      <p style={p}>
        {FIRM.name} provides tax preparation, bookkeeping and related advisory services. The specific
        scope, fees and term of each engagement are set out in the service agreement signed by the
        client. These terms govern use of our client portal and our communications.
      </p>

      <h2 style={h2}>2. Client portal</h2>
      <p style={p}>
        Access is personal and credentials must not be shared. The client is responsible for the
        accuracy and completeness of documents and information submitted. We are not responsible for
        results arising from information that is incorrect or withheld.
      </p>

      <h2 style={h2}>3. Fees and payment</h2>
      <p style={p}>
        Fees are those stated in the service agreement or in the accepted estimate. Recurring services
        are charged on the day agreed in the contract, by authorized automatic debit (card or bank
        account). Declined charges may be retried; if unpaid for fifteen days, services may be
        suspended until the balance is cured. Amounts for work already performed remain due.
      </p>

      <h2 style={h2}>4. Text message program</h2>
      <p style={p}>
        By providing a mobile number and checking the authorization box in our client portal, you
        consent to receive text messages from {FIRM.name} at {FIRM.sms} regarding your services —
        including advance notice of charges, payment confirmations, document requests and report
        availability. Consent is not a condition of purchase. Message frequency varies.{' '}
        <strong>Message and data rates may apply.</strong>
      </p>
      <p style={p}>
        Reply <strong>STOP</strong> to cancel at any time, <strong>START</strong> to resume, or{' '}
        <strong>HELP</strong> for help. Carriers are not liable for delayed or undelivered messages.
        See our <a href="/privacy" style={{ color: '#2D3278' }}>Privacy Policy</a> for how we handle
        your information; we do not sell or share mobile numbers or consent with third parties for
        marketing.
      </p>

      <h2 style={h2}>5. Confidentiality</h2>
      <p style={p}>
        We keep client information confidential and use it only to perform the engaged services or as
        required by law, consistent with the professional standards applicable to tax practitioners.
      </p>

      <h2 style={h2}>6. Termination</h2>
      <p style={p}>
        Either party may terminate an open-ended engagement with thirty days written notice. Amounts
        for periods already worked remain payable. Records are made available in accordance with
        professional standards.
      </p>

      <h2 style={h2}>7. Limitation of liability</h2>
      <p style={p}>
        Our liability arising from the services is limited to the fees paid for the specific service
        in question, except where such limitation is not permitted by law. We are not liable for
        penalties or interest resulting from information not provided or provided incorrectly.
      </p>

      <h2 style={h2}>8. Governing law</h2>
      <p style={p}>
        These terms are governed by the laws of the Commonwealth of Massachusetts, with venue in
        Middlesex County.
      </p>

      <h2 style={h2}>Contact</h2>
      <p style={p}>
        {FIRM.name}<br />
        {FIRM.address}<br />
        Phone: {FIRM.phone} · Text: {FIRM.sms} · {FIRM.email}
      </p>

      <footer style={{ marginTop: 34, paddingTop: 12, borderTop: '1px solid #d8dee8',
        fontSize: 12.5, color: '#5a6a7a' }}>
        See also our <a href="/privacy" style={{ color: '#2D3278' }}>Privacy Policy</a>.
      </footer>
    </main>
  )
}
