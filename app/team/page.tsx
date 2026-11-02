// /team — a lista do CRM juntou-se à equipe (decisão do sócio).
//
// Era um terceiro cadastro da mesma gente, com um rótulo de função que
// qualquer pessoa da equipe trocava. Agora cada pessoa é UMA linha, em
// /settings/users (lib/equipe.ts); este endereço fica para os links e
// favoritos antigos não darem em página vazia.

import { redirect } from 'next/navigation'

export default function TeamPage() {
  redirect('/settings/users')
}
