'use client'
// ChatWidget — botão flutuante canto inferior direito do portal do cliente
// Responde em PT/EN/ES/ZH/FR conforme o idioma do cliente
// Acessibilidade: alvos ≥48px, alto contraste, teclado, sr-only labels

import { useState, useRef, useEffect } from 'react'

interface Message { role: 'user' | 'assistant'; content: string }

interface Props {
  clientId: string
  clientName: string
  lang: string // pt | en | es | zh | fr
}

const GREETINGS: Record<string, string> = {
  pt: 'Olá! Sou a assistente virtual da Peace on Tax. Como posso ajudar você hoje?',
  en: 'Hello! I\'m the Peace on Tax virtual assistant. How can I help you today?',
  es: '¡Hola! Soy el asistente virtual de Peace on Tax. ¿En qué puedo ayudarte hoy?',
  zh: '您好！我是 Peace on Tax 的虚拟助手。今天我可以如何帮助您？',
  fr: 'Bonjour ! Je suis l\'assistante virtuelle de Peace on Tax. Comment puis-je vous aider aujourd\'hui ?',
}

const PLACEHOLDERS: Record<string, string> = {
  pt: 'Digite sua mensagem…', en: 'Type your message…',
  es: 'Escribe tu mensaje…',  zh: '输入您的消息…', fr: 'Tapez votre message…',
}

const SEND_LABELS: Record<string, string> = {
  pt: 'Enviar', en: 'Send', es: 'Enviar', zh: '发送', fr: 'Envoyer',
}

const TITLE: Record<string, string> = {
  pt: 'Assistente Peace on Tax', en: 'Peace on Tax Assistant',
  es: 'Asistente Peace on Tax', zh: 'Peace on Tax 助手', fr: 'Assistant Peace on Tax',
}

export default function ChatWidget({ clientId, clientName, lang }: Props) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', content: GREETINGS[lang] || GREETINGS.en }
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [unread, setUnread] = useState(0)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef  = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (open) {
      setUnread(0)
      setTimeout(() => inputRef.current?.focus(), 150)
    }
  }, [open])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function send() {
    const text = input.trim()
    if (!text || loading) return
    setInput('')

    const userMsg: Message = { role: 'user', content: text }
    const updated = [...messages, userMsg]
    setMessages(updated)
    setLoading(true)

    try {
      const res = await fetch('/api/portal/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: updated, clientId }),
      })
      const data = await res.json()
      const reply = data.reply || (lang === 'pt'
        ? 'Desculpe, não consegui responder agora. Tente novamente ou entre em contato pelo (833) 732-2327.'
        : 'Sorry, I could not respond right now. Please try again or call (833) 732-2327.')

      setMessages(prev => [...prev, { role: 'assistant', content: reply }])
      if (!open) setUnread(n => n + 1)
    } catch {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: lang === 'pt'
          ? 'Serviço temporariamente indisponível. Ligue (833) 732-2327.'
          : 'Service temporarily unavailable. Call (833) 732-2327.',
      }])
    } finally {
      setLoading(false)
    }
  }

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }

  // Formata markdown básico (bold, links)
  function formatContent(text: string): string {
    return text
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g,   '<em>$1</em>')
      .replace(/\n/g, '<br/>')
  }

  return (
    <>
      {/* Painel do chat */}
      {open && (
        <div
          role="dialog"
          aria-label={TITLE[lang]}
          style={{
            position:'fixed', bottom:88, right:20, width:360,
            maxHeight:'70vh', display:'flex', flexDirection:'column',
            background:'#fff', borderRadius:20,
            boxShadow:'0 8px 40px rgba(45,50,120,0.25)',
            border:'2px solid #2D3278', zIndex:1000,
            fontFamily:'system-ui,sans-serif',
          }}
        >
          {/* Header */}
          <div style={{ background:'linear-gradient(135deg,#2D3278,#1a1f5e)', color:'#fff', padding:'14px 18px', borderRadius:'18px 18px 0 0', display:'flex', alignItems:'center', gap:10 }}>
            <div style={{ width:36, height:36, borderRadius:'50%', background:'rgba(255,255,255,0.15)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:18 }}>🤖</div>
            <div style={{ flex:1 }}>
              <div style={{ fontWeight:700, fontSize:14 }}>{TITLE[lang]}</div>
              <div style={{ fontSize:11, opacity:0.8 }}>Peace on Tax Corp · (833) 732-2327</div>
            </div>
            <button
              aria-label="Fechar chat"
              onClick={() => setOpen(false)}
              style={{ background:'rgba(255,255,255,0.15)', border:'none', color:'#fff', width:32, height:32, borderRadius:8, cursor:'pointer', fontSize:18, display:'flex', alignItems:'center', justifyContent:'center' }}
            >×</button>
          </div>

          {/* Mensagens */}
          <div style={{ flex:1, overflowY:'auto', padding:'14px 16px', display:'flex', flexDirection:'column', gap:10, minHeight:200, maxHeight:'50vh' }}>
            {messages.map((m, i) => (
              <div key={i} style={{ display:'flex', justifyContent: m.role==='user' ? 'flex-end' : 'flex-start' }}>
                <div style={{
                  maxWidth:'85%', padding:'10px 14px', borderRadius: m.role==='user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                  background: m.role==='user' ? 'linear-gradient(135deg,#2D3278,#1a1f5e)' : '#f0f4fa',
                  color: m.role==='user' ? '#fff' : '#1a2a3a', fontSize:14, lineHeight:1.5,
                }}
                  dangerouslySetInnerHTML={{ __html: formatContent(m.content) }}
                />
              </div>
            ))}
            {loading && (
              <div style={{ display:'flex', gap:4, padding:'10px 14px', background:'#f0f4fa', borderRadius:'16px 16px 16px 4px', width:'fit-content' }}>
                {[0,1,2].map(i => (
                  <div key={i} style={{
                    width:8, height:8, borderRadius:'50%', background:'#2D3278',
                    animation:`bounce 1s ease-in-out ${i*0.2}s infinite`,
                  }} />
                ))}
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div style={{ padding:'10px 14px', borderTop:'1px solid #e2e8f4', display:'flex', gap:8 }}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder={PLACEHOLDERS[lang]}
              rows={1}
              disabled={loading}
              style={{
                flex:1, border:'1.5px solid #e2e8f4', borderRadius:10, padding:'10px 12px',
                fontSize:14, fontFamily:'inherit', resize:'none', outline:'none',
                minHeight:44, maxHeight:120,
              }}
            />
            <button
              onClick={send}
              disabled={!input.trim() || loading}
              aria-label={SEND_LABELS[lang]}
              style={{
                minWidth:48, minHeight:48, background: input.trim()&&!loading ? '#F47B20' : '#e2e8f4',
                color: input.trim()&&!loading ? '#fff' : '#9aaab0',
                border:'none', borderRadius:10, cursor: input.trim()&&!loading ? 'pointer' : 'not-allowed',
                fontSize:20, display:'flex', alignItems:'center', justifyContent:'center',
              }}
            >➤</button>
          </div>
        </div>
      )}

      {/* Botão flutuante */}
      <button
        onClick={() => setOpen(o => !o)}
        aria-label={open ? 'Fechar assistente' : 'Abrir assistente Peace on Tax'}
        style={{
          position:'fixed', bottom:20, right:20,
          width:60, height:60, borderRadius:'50%',
          background:'linear-gradient(135deg,#2D3278,#1a1f5e)',
          border:'none', cursor:'pointer', zIndex:1001,
          boxShadow:'0 4px 20px rgba(45,50,120,0.4)',
          display:'flex', alignItems:'center', justifyContent:'center',
          fontSize:26, color:'#fff',
          transition:'transform 0.2s',
        }}
        onMouseEnter={e => (e.currentTarget.style.transform='scale(1.1)')}
        onMouseLeave={e => (e.currentTarget.style.transform='scale(1)')}
      >
        {open ? '×' : '💬'}
        {!open && unread > 0 && (
          <span style={{
            position:'absolute', top:-4, right:-4,
            background:'#F47B20', color:'#fff',
            width:20, height:20, borderRadius:'50%',
            fontSize:11, fontWeight:700,
            display:'flex', alignItems:'center', justifyContent:'center',
          }}>{unread}</span>
        )}
      </button>

      {/* Animação dos pontos de digitação */}
      <style>{`
        @keyframes bounce {
          0%,80%,100% { transform: translateY(0); opacity:0.4; }
          40% { transform: translateY(-6px); opacity:1; }
        }
      `}</style>
    </>
  )
}
