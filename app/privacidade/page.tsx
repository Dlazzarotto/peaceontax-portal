// /privacidade — Política de Privacidade (PT)

export const metadata = { title: 'Política de Privacidade — Peace on Tax Corp' }

const FIRM = {
  name: 'Peace on Tax Corp',
  address: '75 Pleasant St Suite 119, Malden, MA 02148',
  phone: '(833) 732-2327',
  email: 'info@peaceontax.com',
}

export default function PrivacidadePage() {
  const s = {
    h2: { fontFamily: 'Georgia,serif', fontSize: 18, color: '#2D3278', margin: '28px 0 10px' } as const,
    p: { fontSize: 15, lineHeight: 1.8, color: '#2a3a4a', margin: '0 0 12px' } as const,
    li: { fontSize: 15, lineHeight: 1.8, color: '#2a3a4a', marginBottom: 6 } as const,
  }
  return (
    <div style={{ background: '#f7f9fc', minHeight: '100vh', padding: '32px 16px' }}>
      <div style={{ maxWidth: 780, margin: '0 auto', background: '#fff', borderRadius: 16, padding: '44px 48px', boxShadow: '0 2px 24px rgba(45,50,120,0.08)' }}>
        <img src="/logo.png" alt={FIRM.name} style={{ height: 52, marginBottom: 18 }} />
        <h1 style={{ fontFamily: 'Georgia,serif', fontSize: 26, color: '#0f2340', margin: '0 0 4px' }}>Política de Privacidade</h1>
        <p style={{ fontSize: 13, color: '#8a9ab0', margin: '0 0 24px' }}>Atualizada em 8 de julho de 2026 · <a href="/privacy" style={{ color: '#F47B20' }}>English version</a></p>

        <p style={s.p}>A <b>{FIRM.name}</b> ("nós") presta serviços de preparação de impostos, contabilidade e bookkeeping. Esta política descreve como coletamos, usamos, protegemos e compartilhamos suas informações no portal do cliente e em nossos serviços.</p>

        <h2 style={s.h2}>Informações que coletamos</h2>
        <ul style={{ paddingLeft: 22 }}>
          <li style={s.li}><b>Dados de identidade e contato</b> — nome, e-mail, telefone, endereço, data de nascimento, SSN/ITIN/EIN, fornecidos por você para os serviços fiscais e contábeis.</li>
          <li style={s.li}><b>Documentos fiscais e financeiros</b> — arquivos que você envia ao portal (W-2, 1099, extratos, recibos).</li>
          <li style={s.li}><b>Dados bancários e de transações</b> — quando você opta por conectar uma conta pelo <b>Plaid Inc.</b>, recebemos informações de conta e transações para fins de bookkeeping. A política do Plaid está em <a href="https://plaid.com/legal/#end-user-privacy-policy" style={{ color: '#F47B20' }}>plaid.com/legal</a>. Não recebemos nem armazenamos sua senha do banco.</li>
          <li style={s.li}><b>Dados de pagamento</b> — processados pela <b>Stripe</b>; não armazenamos números completos de cartão ou conta em nossos servidores.</li>
          <li style={s.li}><b>Dados de uso</b> — atividade de login e ações no portal, mantidos para segurança e auditoria.</li>
        </ul>

        <h2 style={s.h2}>Como usamos suas informações</h2>
        <ul style={{ paddingLeft: 22 }}>
          <li style={s.li}>Preparar declarações e prestar os serviços contábeis, de bookkeeping e consultoria contratados;</li>
          <li style={s.li}>Categorizar transações e gerar relatórios (ex.: P&amp;L) nos contratos de bookkeeping;</li>
          <li style={s.li}>Processar pagamentos e enviar faturas, contratos e assinaturas eletrônicas;</li>
          <li style={s.li}>Comunicar sobre seus serviços;</li>
          <li style={s.li}>Cumprir obrigações legais e regulatórias (IRS, autoridades estaduais).</li>
        </ul>

        <h2 style={s.h2}>O que NÃO fazemos</h2>
        <ul style={{ paddingLeft: 22 }}>
          <li style={s.li}>Não <b>vendemos</b> suas informações pessoais;</li>
          <li style={s.li}>Não usamos nem divulgamos informações da sua declaração fora do permitido pelo IRC §7216 (com seu consentimento ou por exigência legal);</li>
          <li style={s.li}>Não compartilhamos seus dados com terceiros para marketing deles.</li>
        </ul>

        <h2 style={s.h2}>Como protegemos</h2>
        <p style={s.p}>Todos os dados são criptografados em trânsito (TLS 1.2+) e em repouso (AES-256). O acesso é restrito por papéis; ações sensíveis ficam em trilhas de auditoria. Nosso programa de segurança segue a FTC Safeguards Rule e a Publicação 4557 do IRS, aplicáveis a profissionais de impostos.</p>

        <h2 style={s.h2}>Prestadores de serviço</h2>
        <p style={s.p}>Usamos provedores auditados para operar o portal: Supabase (hospedagem segura de dados), Vercel (aplicação), Stripe (pagamentos), DocuSign (assinaturas), Plaid (conexões bancárias, por sua escolha), Resend (e-mails) e Anthropic (assistência na classificação de documentos). Eles processam dados apenas para prestar nossos serviços.</p>

        <h2 style={s.h2}>Retenção</h2>
        <p style={s.p}>Mantemos registros fiscais pelos prazos exigidos em lei (em geral, de 3 a 7 anos). Você pode solicitar cópia dos seus documentos a qualquer momento.</p>

        <h2 style={s.h2}>Seus direitos</h2>
        <ul style={{ paddingLeft: 22 }}>
          <li style={s.li}>Desconectar uma conta bancária vinculada a qualquer momento, pelo portal ou falando conosco;</li>
          <li style={s.li}>Solicitar acesso, correção ou (quando a lei permitir) exclusão de informações;</li>
          <li style={s.li}>Orientar o uso das informações da sua declaração conforme o IRC §7216.</li>
        </ul>

        <h2 style={s.h2}>Fale conosco</h2>
        <p style={s.p}>
          {FIRM.name}<br />
          {FIRM.address}<br />
          {FIRM.phone} · <a href={`mailto:${FIRM.email}`} style={{ color: '#F47B20' }}>{FIRM.email}</a>
        </p>
      </div>
    </div>
  )
}
