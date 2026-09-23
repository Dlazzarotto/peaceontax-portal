-- sql/papel-no-app-metadata-v1.sql
-- Mudar o papel (firma x cliente) de user_metadata para app_metadata.
--
-- RODE ESTA MIGRACAO ANTES DE O CODIGO NOVO SUBIR.
-- Ela e inofensiva com o codigo antigo (que nem olha para app_metadata), e
-- sem ela o codigo novo nao acha o papel de ninguem: a firma inteira entra
-- como cliente, cai no /portal e leva 403 em toda rota.
--
-- POR QUE
-- No Supabase, `user_metadata` (a coluna raw_user_meta_data) e do PROPRIO
-- USUARIO: com a sessao dele e a anon key, que esta no navegador, da para
--
--     supabase.auth.updateUser({ data: { role: 'owner' } })
--
-- Quem lia o papel dali era a porta de entrada inteira -- middleware,
-- getAuth, e o nivel em getStaffLevel quando a pessoa nao tem linha em
-- staff_roles. Ou seja: qualquer cliente do portal podia se declarar OWNER,
-- e owner e imune a concessao negativa (verTotais, estornar, apagar).
--
-- `app_metadata` (raw_app_meta_data) so a service role escreve. O usuario
-- nao alcanca. E por isso que o papel passa a morar la.
--
-- O papel NAO fica nos dois lugares: a copia em user_metadata e apagada.
-- Duas versoes da mesma informacao, uma delas forjavel, e o buraco de volta
-- assim que alguem ler a errada.
--
-- COPIAR CEGO NAO SERVE
-- O papel que esta em user_metadata hoje e justamente o campo que qualquer
-- um podia escrever. Copiar tudo para app_metadata daria ALVARA a quem ja
-- tivesse forjado 'owner' -- o buraco viraria permissao legitima, e com
-- carimbo. (Isto apareceu no teste: um login com role 'owner' forjado
-- passava pela primeira versao desta migracao sem um aviso.)
--
-- Entao a prova nao e o que o login diz de si, e sim staff_roles: a tabela
-- que so o servidor escreve, preenchida no aceite do convite. Quem se diz da
-- firma e NAO esta la vira cliente, e sai na lista do fim com a linha de SQL
-- pronta para o socio promover se for gente de casa.
--
-- IDEMPOTENTE, E ISSO PRECISOU DE CONSERTO
-- A primeira versao decidia olhando para user_metadata. Na SEGUNDA rodada
-- user_metadata ja nao tinha papel nenhum, o coalesce caia em 'client' e a
-- migracao rebaixava a firma INTEIRA -- conferido no PG 16, seis logins,
-- todos viraram cliente. Rodar duas vezes e coisa que acontece.
--
-- Agora quem manda e o estado de DESTINO: login que ja tem papel em
-- app_metadata nao e tocado. So quem ainda nao tem e derivado. Segunda
-- rodada nao encontra nada para fazer.

-- 1) FIRMA: so para quem ainda nao tem papel em app_metadata E staff_roles
--    confirma. O login que ja tem papel la nao e tocado.
update auth.users u
   set raw_app_meta_data = coalesce(u.raw_app_meta_data, '{}'::jsonb)
                         || jsonb_build_object('role', u.raw_user_meta_data->>'role')
 where not (coalesce(u.raw_app_meta_data, '{}'::jsonb) ? 'role')
   and u.raw_user_meta_data->>'role' in ('firm','owner','admin','manager','staff')
   and exists (select 1 from public.staff_roles sr where sr.user_id = u.id);

-- 2) Guarda quem alegava firma sem estar em staff_roles, ANTES de qualquer
--    apagamento -- depois nao haveria como saber quem alegava o que.
drop table if exists papel_revisar;
create temp table papel_revisar as
select u.id, u.email, u.raw_user_meta_data->>'role' as papel_que_alegava
  from auth.users u
 where not (coalesce(u.raw_app_meta_data, '{}'::jsonb) ? 'role')
   and u.raw_user_meta_data->>'role' in ('firm','owner','admin','manager','staff')
   and not exists (select 1 from public.staff_roles sr where sr.user_id = u.id);

-- 3) Todo o resto que ainda nao tem papel vira CLIENTE: os clientes de
--    verdade, quem nunca teve papel, e quem alegava firma sem confirmacao.
--    Deixar vazio faria o codigo decidir por ausencia -- e ausencia e
--    exatamente o que o atacante produz.
update auth.users u
   set raw_app_meta_data = coalesce(u.raw_app_meta_data, '{}'::jsonb)
                         || jsonb_build_object('role', 'client')
 where not (coalesce(u.raw_app_meta_data, '{}'::jsonb) ? 'role');

-- 4) Tira a copia de user_metadata. A partir daqui existe UM lugar so.
update auth.users
   set raw_user_meta_data = raw_user_meta_data - 'role'
 where raw_user_meta_data ? 'role';

-- == Conferencia ===========================================================
do $$
declare
  sem_papel integer; sobrou integer; da_firma integer; clientes integer;
begin
  select count(*) into sem_papel from auth.users
   where not (coalesce(raw_app_meta_data, '{}'::jsonb) ? 'role');
  select count(*) into sobrou   from auth.users where raw_user_meta_data ? 'role';
  select count(*) into da_firma from auth.users
   where raw_app_meta_data->>'role' in ('firm','owner','admin','manager','staff');
  select count(*) into clientes from auth.users
   where coalesce(raw_app_meta_data->>'role','') not in ('firm','owner','admin','manager','staff');

  raise notice 'logins da firma: % | clientes: % | sem papel: % | copia velha: %',
    da_firma, clientes, sem_papel, sobrou;

  if sem_papel <> 0 or sobrou <> 0 then
    raise exception 'Migracao incompleta -- confira os avisos acima';
  end if;
  if da_firma = 0 then
    raise exception 'Nenhum login da firma -- NAO suba o codigo novo, ninguem entraria';
  end if;
end $$;

-- A) A equipe que ficou. Esta lista TEM de bater com quem trabalha na firma.
select 'EQUIPE' as lista, u.email, u.raw_app_meta_data->>'role' as papel, sr.level as nivel
  from auth.users u
  left join public.staff_roles sr on sr.user_id = u.id
 where u.raw_app_meta_data->>'role' in ('firm','owner','admin','manager','staff')
 order by u.email;

-- B) Quem se dizia da firma e nao estava em staff_roles: virou CLIENTE.
--    Se for gente de casa, rode a linha pronta da coluna promover_com (ela
--    entra como staff, o menor nivel -- o resto se ajusta na tela da equipe).
--    Se voce nao reconhece o e-mail, ele nao devia estar aqui: NAO promova.
select 'REVISAR' as lista, r.email, r.papel_que_alegava,
       format(
         'update auth.users set raw_app_meta_data = raw_app_meta_data || ''{"role":"staff"}''::jsonb where id = ''%s'';',
         r.id) as promover_com
  from papel_revisar r
 order by r.email;
