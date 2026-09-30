# Painel de Estoque — guia de uso

Controle de entrada de itens por código de barras, feito para leitura
contínua: você libera a leitura uma vez e escaneia quantos itens quiser em
sequência, **sem clicar em nada entre uma leitura e outra**.

## Como usar

1. Dê dois cliques em **`iniciar.bat`**. Uma janela preta abre (é o servidor —
   deixe ela aberta) e o navegador abre sozinho no painel.
2. Clique em **ENTRADA**. O topo da tela fica verde, sinal de que a leitura
   está liberada. Esse clique é a trava contra digitação acidental no teclado.
3. Escaneie. Cada leitura toca um bipe e mostra uma faixa grande com o
   resultado. Continue escaneando — a leitura fica liberada até fechar a aba.
4. Para desligar, feche a janela preta.

Atalhos: **F2** libera a leitura, **Ctrl+Z** desfaz a última leitura, **Esc**
sai do campo de busca e volta a ler.

## Os bipes

| Som | Significado |
|---|---|
| 1 bipe agudo | Entrada registrada |
| 2 bipes graves | Erro — **nada foi gravado** |
| 1 clique curto e baixo | Leitura repetida ignorada (o leitor disparou duas vezes) |

O som só começa a funcionar depois do primeiro clique na página — é uma
exigência do navegador. Clicar em ENTRADA já resolve isso.

## Quando dá erro

- **JÁ ESTÁ GUARDADO** — esse código já deu entrada e continua no estoque.
- **CLIQUE EM ENTRADA PARA LIBERAR A LEITURA** — a leitura ainda está travada.
- **SEM INTERNET — NÃO GRAVADO** — o banco fica na nuvem (Neon), e o PC
  está sem internet. Nada foi gravado; bipe de novo quando a conexão voltar.
- **ERRO DE CONEXÃO** — o painel deste PC foi desligado. Nada foi
  gravado; abra o `iniciar.bat` de novo.

Em todos os casos a leitura é recusada e **nada é gravado no banco**.

## Acessar de outro aparelho

A janela preta mostra um endereço tipo `http://192.168.0.100:3030`. Digite ele
no celular ou em outro PC **na mesma rede Wi-Fi** para abrir o mesmo painel. As
telas se atualizam sozinhas a cada 20 segundos.

## Onde ficam os dados

Tudo fica num banco **Postgres no Neon** (nuvem), o mesmo que a página de
consulta na Vercel lê. O endereço do banco está no arquivo **`.env`** desta
pasta (`DATABASE_URL=...`). **Não compartilhe esse arquivo**: quem tiver o
endereço consegue ler e apagar o estoque.

Backup: o Neon guarda o histórico e permite restaurar o banco como estava
num momento anterior (no painel do Neon: **Branches → Restore**).

## Configurando o leitor de código de barras

O painel funciona com qualquer leitor USB comum (eles se comportam como
teclado). O ideal é que o leitor esteja configurado para enviar **Enter (CR)
no final** de cada leitura — quase todos já vêm assim de fábrica.

Se o seu não envia Enter, o painel ainda funciona: ele fecha a leitura sozinho
após 120 ms de silêncio, desde que o código tenha 4 caracteres ou mais.

## Detalhes técnicos

- Node.js com uma dependência só: `@neondatabase/serverless`, o driver do
  banco. O `iniciar.bat` roda `npm install` sozinho na primeira vez.
- Banco Postgres no Neon, acessado por HTTP (cada consulta é uma requisição).
- Cada entrada é uma linha da tabela `itens`: `codigo` e `entrada_em`.
  As confirmações e resoluções da tela do Tally ficam em `tally_confirmacoes`
  e `tally_resolvidos`. As tabelas são criadas sozinhas quando o painel sobe.
- Um índice único em `codigo` garante, no próprio banco, que o mesmo código
  nunca seja registrado duas vezes.

Arquivos:

```
server.js         servidor HTTP e API (este PC)
db.js             banco de dados (Neon) e regras de entrada
conferencia.js    conferência Tally, usada aqui e na Vercel
tally.js          leitura do Tally, confirmações e resolvidos
planilha.js       leitores de CSV e .xlsx (sem dependências)
public/
  index.html      painel de leitura
  app.js          captura do leitor de código de barras
  conferencia.*   tela de cruzamento com a planilha
  tally.*         conferência Tally
  consulta.html   consulta só de leitura (a que vai para a Vercel)
  style.css       estilos das telas
api/              função da Vercel (/api/tally/conferencia)
scripts/
  montar-site.js      build da Vercel: só a página de consulta
  migrar-para-neon.js cópia única dos dados antigos para o Neon
vercel.json       configuração do deploy
.env              endereço do banco (segredo, fora do git e do deploy)
iniciar.bat       atalho para ligar tudo (Windows)
```

Para trocar a porta: `set PORTA=8080` antes de rodar `node server.js`.

---

# Conferência com planilha do Power BI

Cruza uma planilha externa com o estoque para ver **a tratativa de cada volume**
guardado — devolução, custódia, entregar, etc.

Abra pelo botão **🔀 Cruzar planilha** no topo do painel.

## Como usar

1. Exporte a planilha do Power BI (`.csv` ou `.xlsx`).
2. **Arraste o arquivo** para cima da área tracejada. Também funciona clicar e
   escolher o arquivo, ou simplesmente **copiar as colunas no Excel e colar
   (Ctrl+V)** na página.
3. O painel adivinha sozinho qual coluna tem o código e qual tem a tratativa, e
   mostra quantos códigos bateram: *"187 de 214 códigos batem com o estoque"*.
   Se errar, é só trocar nos dois seletores — o resultado muda na hora.
4. Sua escolha de colunas fica guardada. Na próxima planilha com as mesmas
   colunas, já vem certo.

## Os três grupos

| Aba | O que mostra |
|---|---|
| **No PBI e no estoque** | O cruzamento em si: volumes da planilha que estão guardados aqui, com a tratativa de cada um |
| **No PBI, fora do estoque** | A planilha cobra, mas o volume nunca foi bipado |
| **No estoque, fora do PBI** | Guardado aqui e a planilha nem menciona — volume esquecido |

## Resumo e conflitos

No topo da lista aparece um bloco por tratativa com a contagem
(`Devolução 12` · `Custódia 5` · `Entregar 3`). **Clique num bloco para filtrar**
a lista só naquela tratativa; clique de novo para soltar.

Quando o mesmo volume aparece na planilha com **tratativas diferentes**, ele
ganha o selo `⚠ 2 tratativas`, a linha fica avermelhada, e um bloco vermelho
**Conflito** aparece no resumo. É o caso que precisa da sua decisão.

## Exportar

O botão **⬇ Exportar CSV** baixa exatamente o que está na tela — respeitando a
aba e o filtro de tratativa ativo. O arquivo sai com separador `;` e BOM UTF-8,
para abrir no Excel em português com acentos certos e colunas separadas.

## Se o cruzamento der zero

Quase sempre é o Excel mexendo no código antes de você:

- **Notação científica.** O Excel transforma `7891234567895` em `7,89123E+12`
  sozinho. O painel desfaz isso automaticamente e avisa quantos códigos
  converteu.
- **Zeros à esquerda comidos.** `0099887766` vira `99887766`. Marque a caixa
  **"ignorar zeros à esquerda ao comparar"** e veja se a contagem sobe.
- **Coluna errada.** Confira o seletor "Coluna do código" — o painel escolhe a
  que mais acerta, mas se o estoque estiver vazio ele não tem como saber.

Espaços, acentos, maiúsculas/minúsculas e espaços invisíveis já são tratados
automaticamente nos dois lados.

## Detalhes técnicos

- Continua **sem nenhuma dependência**. O leitor de `.xlsx` é próprio: um
  `.xlsx` é um ZIP de XMLs, descompactado com o `zlib` embutido do Node.
- O servidor só interpreta o arquivo (`POST /api/planilha`). O cruzamento, os
  filtros e a exportação acontecem no navegador, sobre os dados já carregados —
  por isso trocar de coluna ou filtrar é instantâneo.
- A planilha **não é gravada** no banco. Nada do PBI entra no banco; a
  conferência é só uma visão momentânea.
- Limite de 40 MB por arquivo.

---

# Conferência com o Tally

Compara o que os entregadores **declararam no formulário do Tally** com o que
foi **bipado na ENTRADA**. Abra pelo botão **📋 Conferir Tally** no topo do painel.

## Primeira vez: conectar

1. No Tally: **Settings → API keys → Create API key**.
2. Cole a chave no campo que aparece na tela e clique **Salvar chave**.

A chave fica no arquivo `tally.json` desta pasta (ou na variável
`TALLY_API_KEY`) e nunca vai para o navegador. O formulário usado é o de
`TALLY_FORM_ID` (ou `formId` no `tally.json`). Não compartilhe esse arquivo.
Na Vercel, a chave é a variável de ambiente `TALLY_API_KEY`.

## Como usar

A tela abre com os **últimos 7 dias** já escolhidos. Para outro período, troque
as datas "De" e "até" e clique **⟳ Atualizar**.

| Aba | O que mostra |
|---|---|
| **Preenchido e bipado** | Tudo certo: o entregador declarou e o volume está no estoque |
| **Preenchido, não bipado** | Declarado, mas nunca bipado. Se existe um código bipado **parecido** (erro de digitação, ex: `abcd230382958` × `ABCD230382958TX`), aparece em "Parece ser" |
| **Bipado sem formulário** | Bipado no período e nenhum formulário cita o código |

- Maiúsculas/minúsculas e espaços não atrapalham a comparação.
- Formulários dos **3 dias antes** do período também contam para "Bipado sem
  formulário" — o entregador costuma preencher antes de chegar.
- Avisos no topo: **quantidade informada diferente** do número de códigos
  digitados, formulário **sem nenhum código** e código repetido em dois formulários.
- Os blocos de resumo filtram por tipo (Devolução, Sobra…) e transportadora.
- **⬇ Exportar CSV** baixa a aba que está na tela.

---

# Consulta só de leitura (para colegas)

Junto com o painel sobe uma **segunda porta, a 3051**, que mostra só a tabela
da conferência Tally. É ela que pode ir para a internet.

- Abre com os **últimos 7 dias**; o período fica junto dos filtros.
- Dá para buscar, filtrar por situação e transportadora, abrir o formulário
  de um produto e exportar CSV.
- **Não grava nada.** O servidor recusa qualquer envio (`POST`) nessa porta e
  não entrega as outras telas nem as outras rotas da API. Não existe botão
  de confirmar código, de apagar, nem de trocar a chave do Tally.
- Período máximo de 93 dias por busca.

Na rede local: `http://<ip-deste-pc>:3051`. Para trocar a porta:
`set PORTA_CONSULTA=4000`.

## Na internet (Vercel)

A consulta fica publicada na **Vercel** e lê o mesmo banco do Neon. Ela
funciona **com este PC desligado**; o que depende do PC é só a bipagem.

Só a página de consulta vai para a internet: o build (`scripts/montar-site.js`)
publica `consulta.html`, `tally.js`, `normalizar.js` e `style.css`, e a única
rota é `GET /api/tally/conferencia`. O painel de bipagem, a conferência do PBI
e a tela do Tally com confirmar/resolver não existem lá.

Variáveis de ambiente no projeto da Vercel (**Settings → Environment Variables**):

| Nome | Valor |
|---|---|
| `DATABASE_URL` | o mesmo endereço do `.env` |
| `TALLY_API_KEY` | a chave do Tally (a mesma do `tally.json`) |
| `TALLY_FORM_ID` | o id do formulário de conferência |

Para publicar uma nova versão depois de mexer no código: `npx vercel --prod`
nesta pasta.
