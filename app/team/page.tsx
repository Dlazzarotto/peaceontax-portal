'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'

interface Member { id: string; name: string; email: string | null; role: string; active: boolean }

const ROLES: Record<string, string> = { owner: 'Sócio', manager: 'Gerente', junior: 'Assistente' }

export default function TeamPage() {
  const [members, setMembers] = useState<Member[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('junior')
  const [busy, setBusy] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const d = await fetch('/api/team?all=1').then(r => r.json())
      if (d?.members) setMembers(d.members)
      else setMsg(`Não foi possível carregar: ${d?.error || 'erro desconhecido'}`)
    } catch (e) { setMsg((e as Error).message) }
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const add = async () => {
    if (name.trim().length < 2) { setMsg('Informe o nome completo.'); return }
    setBusy(true); setMsg('')
    const d = await fetch('/api/team', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, email, role }),
    }).then(r => r.json()).catch(e => ({ error: String(e) }))
    setBusy(false)
    if (!d?.ok) { setMsg(`⚠️ ${d?.error}`); return }
    setMsg(`✓ ${d.member.name} entrou na equipe.`)
    setName(''); setEmail(''); setRole('junior')
    load()
  }

  const patch = async (body: any, aviso: string) => {
    setBusy(true); setMsg('')
    const d = await fetch('/api/team', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json()).catch(e => ({ error: String(e) }))
    setBusy(false)
    if (!d?.ok) { setMsg(`⚠️ ${d?.error}`); return }
    setMsg(aviso + (d.renomeados ? ` · ${d.renomeados} cliente(s) atualizados` : ''))
    setEditId(null)
    load()
  }

  const card: React.CSSProperties = { background: '#fff', border: '1px solid #E2E8F4', borderRadius: 16, padding: '20px 22px', marginBottom: 18 }
  const inp: React.CSSProperties = { padding: '11px 13px', border: '1.5px solid #E2E8F4', borderRadius: 10, fontSize: 15, outline: 'none' }
  const btn = (bg: string, off = false): React.CSSProperties => ({
    padding: '11px 18px', background: off ? '#E2E8F4' : bg, color: off ? '#9AAAB0' : '#fff',
    border: 'none', borderRadius: 10, fontSize: 14.5, fontWeight: 700, cursor: off ? 'not-allowed' : 'pointer',
  })

  const ativos = members.filter(m => m.active)
  const inativos = members.filter(m => !m.active)

  return (
    <div style={{ maxWidth: 780 }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontFamily: 'Georgia,serif', fontSize: 28, color: '#0F2340', margin: '0 0 4px', fontWeight: 400 }}>
          Equipe
        </h1>
        <p style={{ fontSize: 14.5, color: '#6A7A9A', margin: 0, lineHeight: 1.5 }}>
          Quem aparece como responsável nos clientes. Ao sair da firma, desative — o histórico dos
          clientes que a pessoa atendeu continua registrado.
        </p>
      </div>

      {msg && (
        <div style={{
          marginBottom: 16, padding: '12px 16px', borderRadius: 10, fontSize: 14.5, fontWeight: 700,
          background: msg.startsWith('✓') ? '#E8F5EE' : '#FEE2E2',
          color: msg.startsWith('✓') ? '#1A6B4A' : '#B02020',
        }}>
          {msg}
          <button onClick={() => setMsg('')} style={{ float: 'right', background: 'none', border: 'none', cursor: 'pointer', fontSize: 15, color: 'inherit', fontWeight: 800 }}>✕</button>
        </div>
      )}

      <section style={card}>
        <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 18, color: '#0F2340', margin: '0 0 12px', fontWeight: 400 }}>
          Incluir na equipe
        </h2>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Nome completo"
            style={{ ...inp, flex: '2 1 220px' }} />
          <input value={email} onChange={e => setEmail(e.target.value)} placeholder="E-mail (opcional)"
            style={{ ...inp, flex: '2 1 200px' }} />
          <select value={role} onChange={e => setRole(e.target.value)} style={{ ...inp, flex: '1 1 140px', cursor: 'pointer' }}>
            <option value="junior">Assistente</option>
            <option value="manager">Gerente</option>
            <option value="owner">Sócio</option>
          </select>
          <button onClick={add} disabled={busy} style={btn('#2D3278', busy)}>Incluir</button>
        </div>
      </section>

      <section style={card}>
        <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 18, color: '#0F2340', margin: '0 0 12px', fontWeight: 400 }}>
          Na equipe ({ativos.length})
        </h2>

        {loading ? <p style={{ fontSize: 14.5, color: '#6A7A9A' }}>Carregando…</p>
          : ativos.length === 0 ? (
            <p style={{ fontSize: 14.5, color: '#4A5A70', margin: 0 }}>
              Ninguém cadastrado ainda. Inclua acima para poder atribuir clientes.
            </p>
          ) : ativos.map(m => (
            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderTop: '1px solid #F0F4FA' }}>
              <div style={{
                width: 40, height: 40, borderRadius: 12, background: '#2D327812', color: '#2D3278',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 800, flexShrink: 0,
              }}>
                {m.name.trim().split(/\s+/).slice(0, 2).map(p => p[0]).join('').toUpperCase()}
              </div>

              {editId === m.id ? (
                <>
                  <input value={editName} onChange={e => setEditName(e.target.value)} style={{ ...inp, flex: 1 }} />
                  <button onClick={() => patch({ id: m.id, name: editName, oldName: m.name }, '✓ Nome atualizado.')}
                    disabled={busy} style={btn('#1A6B4A', busy)}>Salvar</button>
                  <button onClick={() => setEditId(null)} style={btn('#6A7A9A')}>Cancelar</button>
                </>
              ) : (
                <>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 16, fontWeight: 700, color: '#0F2340' }}>{m.name}</div>
                    <div style={{ fontSize: 13.5, color: '#6A7A9A' }}>
                      {ROLES[m.role] || m.role}{m.email ? ` · ${m.email}` : ''}
                    </div>
                  </div>
                  <select value={m.role} onChange={e => patch({ id: m.id, role: e.target.value }, '✓ Função atualizada.')}
                    style={{ ...inp, padding: '7px 10px', fontSize: 13.5, cursor: 'pointer' }}>
                    <option value="junior">Assistente</option>
                    <option value="manager">Gerente</option>
                    <option value="owner">Sócio</option>
                  </select>
                  <button onClick={() => { setEditId(m.id); setEditName(m.name) }}
                    style={{ background: 'none', border: 'none', color: '#2D3278', fontSize: 13.5, fontWeight: 700, cursor: 'pointer' }}>
                    Renomear
                  </button>
                  <button onClick={() => patch({ id: m.id, active: false }, `✓ ${m.name} saiu da equipe.`)}
                    style={{ background: 'none', border: 'none', color: '#B02020', fontSize: 13.5, fontWeight: 700, cursor: 'pointer' }}>
                    Desativar
                  </button>
                </>
              )}
            </div>
          ))}
      </section>

      {inativos.length > 0 && (
        <section style={card}>
          <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 18, color: '#0F2340', margin: '0 0 12px', fontWeight: 400 }}>
            Fora da equipe ({inativos.length})
          </h2>
          {inativos.map(m => (
            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderTop: '1px solid #F0F4FA' }}>
              <div style={{ flex: 1, fontSize: 15, color: '#6A7A9A' }}>
                {m.name} <span style={{ fontSize: 13 }}>· {ROLES[m.role] || m.role}</span>
              </div>
              <button onClick={() => patch({ id: m.id, active: true }, `✓ ${m.name} voltou para a equipe.`)}
                style={{ background: 'none', border: 'none', color: '#1A6B4A', fontSize: 13.5, fontWeight: 700, cursor: 'pointer' }}>
                Reativar
              </button>
            </div>
          ))}
        </section>
      )}

      <Link href="/clients" style={{ fontSize: 14.5, color: '#2D3278', fontWeight: 700, textDecoration: 'none' }}>
        ← Voltar ao CRM
      </Link>
    </div>
  )
}
