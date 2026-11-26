# MyLife

Aplicativo web mobile-first em HTML, CSS e JavaScript, instalável como PWA no iPhone. Organize finanças, compromissos, tarefas, metas, contas, compras, notas, cofrinhos, assinaturas, hábitos e prioridades diárias. Os dados ficam no IndexedDB e podem sincronizar entre dispositivos com Supabase.

O aplicativo começa sem dados de demonstração. A moeda inicial é EUR e pode ser alterada para BRL ou USD nas configurações.

Em **Configurações**, escolha entre cinco paletas de cores, modo claro/escuro, três densidades de interface e gráficos de barras ou circulares. O botão **Sortear cores e modelo** aplica uma combinação aleatória. Os relatórios também mostram taxa de economia, quantidade de movimentações e média das despesas.

## Executar

Requer Node.js 18 ou superior. Copie `.env.example` para `.env`, preencha os valores de Supabase e do provedor de IA e inicie o servidor:

```powershell
node --env-file=.env server.js
```

O carregamento automático de `.env` requer Node.js 20.6 ou superior. Com Node.js 18, configure as variáveis de ambiente no terminal ou na hospedagem antes de executar `node server.js`. O servidor usa apenas APIs nativas do Node.js.

Abra `http://localhost:3000`. Sem configuração de nuvem, as funcionalidades locais continuam disponíveis e ficam salvas no navegador. A interface funciona offline depois de carregada; a sincronização Supabase e o assistente precisam de internet.

O GitHub Pages pode hospedar apenas os arquivos estáticos da interface; ele não executa `server.js`. Nesse caso, o modo local pode funcionar, mas login/sincronização e assistente de IA precisam do backend Node.js publicado em um serviço como Render.

## Supabase

1. Crie um projeto Supabase e execute [`supabase/schema.sql`](supabase/schema.sql) no SQL Editor. Isso cria uma linha privada por conta autenticada em `mylife_data`; o `user_id` está ligado a `auth.users` e o RLS impede que uma conta leia ou altere os dados de outra.
2. Preencha `SUPABASE_URL` e `SUPABASE_ANON_KEY` no `.env`.
3. Configure os provedores de e-mail e as URLs de redirecionamento em **Authentication → URL Configuration** no painel do Supabase.

A chave anon/publishable é entregue ao navegador e não deve ser tratada como segredo. O acesso aos dados é protegido por Row Level Security. **Nunca** use a chave `service_role` no frontend ou como `SUPABASE_ANON_KEY`.

Ao entrar, o MyLife carrega o registro da conta e combina com os registros locais que ainda não existem na nuvem antes de sincronizar. Assim, itens locais únicos não são substituídos por uma conta vazia ou por dados já existentes na nuvem. A importação de backup também combina os registros e mantém a versão atual quando há um ID repetido.

Para mover dados locais de um endereço/instalação antiga para outra hospedagem, abra o MyLife antigo e use **Configurações → Exportar backup**. Depois, entre na sua conta no novo endereço e importe o arquivo de backup; os registros serão combinados com os da nuvem. Dados guardados no navegador são separados por endereço, então não aparecem automaticamente em outro domínio. Mantenha uma cópia independente dos dados importantes.

## Assistente de IA

Defina `AI_API_KEY` no ambiente do servidor, nunca no navegador. O backend valida a sessão do Supabase, limita mensagens e solicitações, verifica a origem e encaminha apenas a mensagem escrita ao provedor de IA. `AI_API_URL` e `AI_MODEL` permitem usar um endpoint compatível com a API de chat completions.

## Dados e integrações

- Pagamentos confirmados de contas e assinaturas criam uma movimentação vinculada para evitar lançamentos repetidos. Assinaturas só viram despesas depois de confirmar a cobrança.
- Depósitos e retiradas de cofrinhos ajustam o saldo disponível como transferências internas, sem criar receitas ou despesas.
- Um cofrinho pode ser vinculado a uma meta para atualizar o progresso automaticamente.
- Exportação e importação de backup JSON estão disponíveis em Configurações; a importação combina registros, sem substituir itens únicos já existentes.
- O botão de apagar dados remove os dados locais do perfil atual e, se conectado, o registro na nuvem.

## Instalar no iPhone

Publique o servidor em uma hospedagem com HTTPS. No iPhone, abra o endereço no Safari, toque em **Compartilhar → Adicionar à Tela de Início**. O service worker mantém a interface disponível offline; sincronização e assistente precisam de internet.

## Privacidade e produção

Configure HTTPS, domínios permitidos e variáveis de ambiente na hospedagem. O controle de limite de solicitações do exemplo fica em memória e deve ser substituído por rate limiting compartilhado em uma implantação com várias instâncias. Os registros ficam no armazenamento local até o usuário ativar uma conta; em uma conta sem dados prévios na nuvem, os dados locais são importados para a sincronização.
