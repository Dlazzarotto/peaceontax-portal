'use client'
import { useState, useEffect, useRef } from 'react'

const T: Record<string, any> = {
  en: { title: 'Messages', placeholder: 'Type a message…', send: 'Send', noMessages: 'No messages yet. Start the conversation!', you: 'You', firm: 'Peace on Tax' },
  pt: { title: 'Mensagens', placeholder: 'Digite uma mensagem…', send: 'Enviar', noMessages: 'Nenhuma mensagem ainda. Inicie a conversa!', you: 'Você', firm: 'Peace on Tax' },
  es: { title: 'Mensajes', placeholder: 'Escriba un mensaje…', send: 'Enviar', noMessages: '¡No hay mensajes aún. ¡Inicie la conversación!', you: 'Usted', firm: 'Peace on Tax' },
  zh: { title: '消息', placeholder: '输入消息…', send: '发送', noMessages: '暂无消息，开始对话吧！', you: '您', firm: 'Peace on Tax' },
}

export default function MessagesPage() {
  const [client,   setClient]   = useState<any>(null)
  const [messages, setMessages] = useState<any[]>([])
  const [text,     setText]     = useState('')
  const [loading,  setLoading]  = useState(true)
  const [sending,  setSending]  = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const load = async () => {
    const res = await fetch('/api/portal/messages')
    const d   = await res.json()
    setClient(d.client)
    setMessages(d.messages || [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  const send = async () => {
    if (!text.trim() || sending) return
    setSending(true)
    const res = await fetch('/api/portal/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.trim() }),
    })
    const d = await res.json()
    setSending(false)
    if (!d.error) { setText(''); load() }
  }

  const lang = client?.language || 'en'
  const t    = T[lang] || T.en

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#6a7a9a' }}>Loading…</div>

  return (
    <div>
      <h1 style={{ fontFamily: 'Georgia,serif', fontSize: 22, color: '#0f2340', marginBottom: 20 }}>{t.title}</h1>

      <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e2e8f4', display: 'flex', flexDirection: 'column', height: 'calc(100vh - 200px)', minHeight: 400 }}>
        {/* Header */}
        <div style={{ padding: '14px 18px', borderBottom: '1px solid #e2e8f4', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'linear-gradient(135deg,#2D3278,#1a1f5e)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>📒</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14, color: '#0f2340' }}>Peace on Tax</div>
            <div style={{ fontSize: 11, color: '#6a7a9a' }}>{client?.assignee || 'Your Accountant'}</div>
          </div>
        </div>

        {/* Messages */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {messages.length === 0 ? (
            <div style={{ textAlign: 'center', color: '#9aaab0', padding: '40px 0', fontSize: 13 }}>
              <div style={{ fontSize: 36, marginBottom: 10 }}>💬</div>
              {t.noMessages}
            </div>
          ) : (
            messages.map((msg: any) => {
              const isClient = msg.sender === 'client'
              return (
                <div key={msg.id} style={{ display: 'flex', justifyContent: isClient ? 'flex-end' : 'flex-start' }}>
                  <div style={{ maxWidth: '70%' }}>
                    <div style={{ fontSize: 10, color: '#9aaab0', marginBottom: 3, textAlign: isClient ? 'right' : 'left' }}>
                      {isClient ? t.you : t.firm} · {new Date(msg.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                    </div>
                    <div style={{ background: isClient ? 'linear-gradient(135deg,#2D3278,#1a1f5e)' : '#f0f4fa', color: isClient ? '#fff' : '#1a2a3a', padding: '10px 14px', borderRadius: isClient ? '12px 12px 4px 12px' : '12px 12px 12px 4px', fontSize: 14, lineHeight: 1.5 }}>
                      {msg.text}
                    </div>
                  </div>
                </div>
              )
            })
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div style={{ padding: '12px 16px', borderTop: '1px solid #e2e8f4', display: 'flex', gap: 10 }}>
          <input
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && send()}
            placeholder={t.placeholder}
            style={{ flex: 1, padding: '10px 14px', border: '1.5px solid #e2e8f4', borderRadius: 10, fontSize: 14, outline: 'none', fontFamily: 'Georgia,serif' }}
          />
          <button onClick={send} disabled={!text.trim() || sending} style={{ background: text.trim() && !sending ? 'linear-gradient(135deg,#2D3278,#1a1f5e)' : '#e2e8f4', color: text.trim() && !sending ? '#fff' : '#9aaab0', border: 'none', padding: '10px 20px', borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: text.trim() && !sending ? 'pointer' : 'not-allowed', fontFamily: 'Georgia,serif' }}>
            {sending ? '…' : t.send}
          </button>
        </div>
      </div>
    </div>
  )
}
