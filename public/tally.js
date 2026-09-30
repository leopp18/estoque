'use strict';

/* ==========================================================================
   Conferência Tally × bipagem.

   O servidor traz, de uma vez, os envios do formulário (já com os códigos
   separados), as entradas bipadas no período e a situação de todo o estoque.
   O cruzamento, os filtros e a exportação acontecem aqui.

   A tela imita a aba "Submissions" do Tally: uma tabela só, um produto por
   linha, com a situação marcada na própria linha. Clicar abre o formulário
   inteiro num painel lateral.
   ========================================================================== */

const MAX_LINHAS_NA_TELA = 1000;

// consulta.html usa este mesmo arquivo como página só de leitura: sem chave,
// sem confirmar/desfazer e sem os blocos de resumo, tipo e qtd divergente.
const SO_LEITURA = document.body.dataset.soLeitura === '1';
const TAMANHO_MIN_SUGESTAO = 8;   // códigos curtos parecem demais uns com os outros
const DISTANCIA_MAX_SUGESTAO = 2;

const el = (id) => document.getElementById(id);

const ui = {
  areaChave: el('area-chave'),
  inpChave: el('inp-chave'),
  btnSalvarChave: el('btn-salvar-chave'),
  inpDe: el('inp-de'),
  inpAte: el('inp-ate'),
  btnAtualizar: el('btn-atualizar'),
  status: el('status') || document.createElement('span'), // a consulta não mostra
  erro: el('erro'),
  avisos: el('avisos'),
  btnAlertas: el('btn-alertas'),
  areaResultado: el('area-resultado'),
  filtrosProdutos: el('filtros-produtos'),
  selTransportadora: el('sel-transportadora'),
  selTipo: el('sel-tipo'),
  cabecalho: el('cabecalho'),
  corpo: el('corpo'),
  vazio: el('vazio'),
  rodape: el('rodape'),
  busca: el('busca'),
  btnExportar: el('btn-exportar'),
  painel: el('painel'),
  painelFundo: el('painel-fundo'),
  painelCodigo: el('painel-codigo'),
  painelCorpo: el('painel-corpo'),
  painelFechar: el('painel-fechar'),
};

const estado = {
  dados: null,          // resposta crua do servidor
  cruzamento: null,     // {produtos, semFormulario, ...}
  aba: 'produtos',      // 'produtos' | 'sem-formulario'
  status: 'todos',      // 'todos' | 'bateu' | 'nao-bipado' | 'qtd'
  transportadora: '',
  tipo: '',
  busca: '',
};

/* ---------------------------------------------------------------- datas -- */

const fmtData = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
});
const formatar = (iso) => (iso ? fmtData.format(new Date(iso)) : '');

const doisDigitos = (n) => String(n).padStart(2, '0');
const paraInput = (d) => `${d.getFullYear()}-${doisDigitos(d.getMonth() + 1)}-${doisDigitos(d.getDate())}`;

function deInput(valor) {
  const [a, m, d] = valor.split('-').map(Number);
  return new Date(a, m - 1, d);
}

/** Período padrão ao abrir a tela: os últimos 7 dias, contando hoje. */
function aplicarPeriodoPadrao() {
  const ate = new Date();
  ate.setHours(0, 0, 0, 0);
  const de = new Date(ate);
  de.setDate(de.getDate() - 6);

  ui.inpDe.value = paraInput(de);
  ui.inpAte.value = paraInput(ate);
}

/** Dia local inteiro: do começo de "De" até o começo do dia seguinte a "Até". */
function periodoEscolhido() {
  if (!ui.inpDe.value || !ui.inpAte.value) return null;
  const inicio = deInput(ui.inpDe.value);
  const fim = deInput(ui.inpAte.value);
  fim.setDate(fim.getDate() + 1);
  return fim > inicio ? { inicio, fim } : null;
}

/* ----------------------------------------------------------- servidor ---- */

function mostrarErro(mensagem) {
  ui.erro.textContent = mensagem;
  ui.erro.hidden = !mensagem;
}

async function verificarChave() {
  if (SO_LEITURA) return true;
  try {
    const r = await (await fetch('/api/tally/status')).json();
    ui.areaChave.hidden = r.temChave;
    return r.temChave;
  } catch {
    mostrarErro('Não consegui falar com o servidor do estoque. O painel está ligado?');
    return false;
  }
}

async function salvarChave() {
  const chave = ui.inpChave.value.trim();
  if (!chave) return;
  ui.btnSalvarChave.disabled = true;
  try {
    const r = await (await fetch('/api/tally/chave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chave }),
    })).json();
    if (!r.ok) return mostrarErro('Não foi possível salvar a chave.');
    ui.inpChave.value = '';
    ui.areaChave.hidden = true;
    atualizar();
  } catch {
    mostrarErro('Erro de conexão com o servidor. O painel ainda está ligado?');
  } finally {
    ui.btnSalvarChave.disabled = false;
  }
}

async function atualizar() {
  const periodo = periodoEscolhido();
  if (!periodo) return mostrarErro('Escolha um período válido ("De" antes de "Até").');

  mostrarErro('');
  if (ui.btnAtualizar) ui.btnAtualizar.disabled = true;
  ui.status.textContent = 'Buscando no Tally…';

  try {
    const params = new URLSearchParams({
      inicio: periodo.inicio.toISOString(),
      fim: periodo.fim.toISOString(),
    });
    const r = await (await fetch('/api/tally/conferencia?' + params)).json();

    if (!r.ok) {
      ui.status.textContent = '';
      if (!SO_LEITURA && (r.erro === 'sem_chave' || r.erro === 'chave_invalida')) ui.areaChave.hidden = false;
      return mostrarErro(r.mensagem || 'Não foi possível buscar os formulários.');
    }

    estado.dados = r;
    estado.cruzamento = cruzar(r);
    estado.transportadora = '';
    estado.tipo = '';
    ui.areaResultado.hidden = false;
    ui.status.textContent = 'Atualizado às ' +
      new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    fecharPainel();
    renderizarResumo();
    renderizarAvisos();
    preencherSelects();
    renderizar();
  } catch {
    ui.status.textContent = '';
    mostrarErro('Erro de conexão com o servidor. O painel ainda está ligado?');
  } finally {
    if (ui.btnAtualizar) ui.btnAtualizar.disabled = false;
  }
}

/* ------------------------------------------------------------ parecidos -- */

/** Levenshtein que desiste assim que passa do limite. */
function distancia(a, b, limite) {
  if (Math.abs(a.length - b.length) > limite) return limite + 1;
  let anterior = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const atual = [i];
    let menor = i;
    for (let j = 1; j <= b.length; j++) {
      const custo = a[i - 1] === b[j - 1] ? 0 : 1;
      atual[j] = Math.min(anterior[j] + 1, atual[j - 1] + 1, anterior[j - 1] + custo);
      if (atual[j] < menor) menor = atual[j];
    }
    if (menor > limite) return limite + 1;
    anterior = atual;
  }
  return anterior[b.length];
}

/**
 * Procura um código bipado parecido com o que o entregador digitou. Olha
 * primeiro os bipados que ficaram sem formulário (o caso mais provável de
 * erro de digitação) e depois o estoque inteiro.
 */
function sugerir(chave, candidatosPreferidos, todos) {
  if (chave.length < TAMANHO_MIN_SUGESTAO) return null;
  for (const lista of [candidatosPreferidos, todos]) {
    let melhor = null;
    let melhorDist = DISTANCIA_MAX_SUGESTAO + 1;
    for (const c of lista) {
      const d = distancia(chave, c.chave, DISTANCIA_MAX_SUGESTAO);
      if (d > 0 && d < melhorDist) { melhor = c; melhorDist = d; }
    }
    if (melhor) return melhor;
  }
  return null;
}

/* ------------------------------------------------------------ cruzamento -- */

function cruzar({ submissoes, bipados, estoque, confirmacoes = {}, resolvidos = {} }) {
  const estoquePorChave = new Map();
  for (const item of estoque) {
    const chave = normalizarCodigo(item.codigo);
    if (chave) estoquePorChave.set(chave, item);
  }

  // Todos os códigos declarados, inclusive os da folga antes do período:
  // servem para não acusar "sem formulário" à toa. Um código confirmado
  // conta como declarado pelo formulário onde foi digitado errado.
  const declaradosQualquer = new Set();
  for (const s of submissoes) {
    for (const c of s.codigos) {
      const chave = normalizarCodigo(c);
      declaradosQualquer.add(chave);
      if (confirmacoes[chave]) declaradosQualquer.add(normalizarCodigo(confirmacoes[chave].codigo));
    }
  }

  // Um registro por código declarado no período, juntando repetições.
  const porChave = new Map();
  const doPeriodo = submissoes.filter((s) => s.no_periodo);

  for (const s of doPeriodo) {
    s.qtdDiferente = s.quantidade !== null && s.codigos.length > 0 &&
      s.quantidade !== s.codigos.length;

    for (const bruto of s.codigos) {
      const chave = normalizarCodigo(bruto);
      if (!chave) continue;
      let reg = porChave.get(chave);
      if (!reg) {
        reg = { chave, bruto, envios: [] };
        porChave.set(chave, reg);
      }
      if (!reg.envios.includes(s)) reg.envios.push(s);
    }
  }

  const bipadosPorChave = new Map();
  for (const b of bipados) {
    const chave = normalizarCodigo(b.codigo);
    if (chave && !bipadosPorChave.has(chave)) bipadosPorChave.set(chave, { chave, ...b });
  }

  const semFormulario = [...bipadosPorChave.values()]
    .filter((b) => !declaradosQualquer.has(b.chave))
    .map((b) => ({ chave: b.chave, bruto: b.codigo, bipado: b, envios: [], parecidoCom: null }));

  const todosDoEstoque = [...estoquePorChave.entries()].map(([chave, item]) => ({ chave, item }));

  const produtos = [];
  const linhaPorChave = new Map();

  for (const reg of porChave.values()) {
    // Sem o código exato no estoque, vale o que o operador confirmou.
    let chaveReal = reg.chave;
    const confirmacao = confirmacoes[reg.chave];
    if (!estoquePorChave.has(reg.chave) && confirmacao) {
      const chaveConfirmada = normalizarCodigo(confirmacao.codigo);
      if (estoquePorChave.has(chaveConfirmada)) chaveReal = chaveConfirmada;
    }

    const item = estoquePorChave.get(chaveReal);
    const bipado = bipadosPorChave.get(chaveReal) || null;
    const linha = {
      ...reg,
      item: item || null,
      bipado,
      status: item ? 'bateu' : 'nao-bipado',
      confirmadoComo: chaveReal !== reg.chave ? confirmacao.codigo : null,
      qtdDiferente: reg.envios.some((s) => s.qtdDiferente),
      sugestao: null,
    };

    // Tratado fora do sistema: sai de "Não recebido" e conta como resolvido.
    const resolucao = !item && resolvidos[reg.chave];
    if (resolucao) {
      linha.status = 'resolvido';
      linha.observacao = resolucao.observacao;
    }

    if (!item) {
      const parecido = sugerir(reg.chave, semFormulario, todosDoEstoque);
      if (parecido) {
        linha.sugestao = { codigo: parecido.bruto ?? parecido.item.codigo, chave: parecido.chave };
        if (parecido.bipado) {
          parecido.parecidoCom = reg.bruto;
          parecido.parecidoComChave = reg.chave;
        }
      }
    }

    produtos.push(linha);
    linhaPorChave.set(reg.chave, linha);
  }

  const semCodigo = doPeriodo.filter((s) => s.codigos.length === 0);
  const repetidos = produtos.filter((r) => r.envios.length > 1);

  return {
    produtos, semFormulario, linhaPorChave,
    doPeriodo, semCodigo, repetidos,
    batem: produtos.filter((r) => r.status !== 'nao-bipado').length,
  };
}

/* ------------------------------------------------------------ resumo/avisos */

function renderizarResumo() {
  const c = estado.cruzamento;
  const total = c.produtos.length;
  if (!SO_LEITURA) {
    el('r-batem').textContent = String(c.batem);
    el('r-total').textContent = String(total);
    el('r-barra').style.width = total ? `${(c.batem / total) * 100}%` : '0%';
    el('r-extra').textContent =
      `${c.doPeriodo.length} ${c.doPeriodo.length === 1 ? 'formulário' : 'formulários'} · ` +
      `${estado.dados.bipados.length} bipados no período`;
  }
  el('n-produtos').textContent = String(total);
  el('n-sem-formulario').textContent = String(c.semFormulario.length);
  el('n-sem-formulario').classList.toggle('tl-aba-n-alerta', c.semFormulario.length > 0);
}

function renderizarAvisos() {
  const c = estado.cruzamento;
  const avisos = [];

  for (const s of c.doPeriodo.filter((x) => x.qtdDiferente)) {
    avisos.push(
      `${descreverEnvio(s)}: informou quantidade ${s.quantidade}, ` +
      `mas digitou ${s.codigos.length} código(s).`
    );
  }
  for (const s of c.semCodigo) {
    avisos.push(
      `${descreverEnvio(s)}: formulário sem nenhum código digitado` +
      (s.quantidade ? ` (quantidade ${s.quantidade}).` : '.')
    );
  }
  if (c.repetidos.length) {
    avisos.push(
      `${c.repetidos.length} código(s) aparecem em mais de um formulário: ` +
      c.repetidos.slice(0, 5).map((r) => r.bruto).join(', ') +
      (c.repetidos.length > 5 ? '…' : '')
    );
  }

  ui.avisos.replaceChildren(...avisos.map((texto) => {
    const div = document.createElement('div');
    div.className = 'aviso';
    div.textContent = texto;
    return div;
  }));
  ui.avisos.hidden = true;
  ui.btnAlertas.hidden = avisos.length === 0;
  ui.btnAlertas.textContent = `⚠ ${avisos.length} ${avisos.length === 1 ? 'alerta' : 'alertas'}`;
  ui.btnAlertas.classList.remove('ativo');
}

const descreverEnvio = (s) =>
  [formatar(s.enviado_em), s.transportadora, s.cidade].filter(Boolean).join(' · ');

/* -------------------------------------------------------------- filtros -- */

/** Valores únicos de um campo entre os envios de uma linha. */
const valoresDe = (linha, campo) =>
  [...new Set(linha.envios.map((s) => s[campo]).filter(Boolean))];

function preencherSelects() {
  const preencher = (select, campo, rotuloTodos) => {
    const contagem = new Map();
    for (const r of estado.cruzamento.produtos) {
      for (const v of valoresDe(r, campo)) contagem.set(v, (contagem.get(v) || 0) + 1);
    }
    const opcoes = [new Option(rotuloTodos, '')];
    for (const [valor, n] of [...contagem.entries()].sort((a, b) => b[1] - a[1])) {
      opcoes.push(new Option(`${valor} (${n})`, valor));
    }
    select.replaceChildren(...opcoes);
    select.hidden = contagem.size === 0;
  };
  preencher(ui.selTransportadora, 'transportadora', 'Todas as transportadoras');
  if (ui.selTipo) preencher(ui.selTipo, 'tipo', 'Todos os tipos');
}

function passaNaBusca(r) {
  if (!estado.busca) return true;
  const b = estado.busca.toUpperCase();
  return r.chave.includes(b) ||
    r.bruto.toUpperCase().includes(b) ||
    (r.sugestao?.chave || '').includes(b) ||
    (r.confirmadoComo || '').toUpperCase().includes(b) ||
    (r.observacao || '').toUpperCase().includes(b) ||
    r.envios.some((s) =>
      `${s.transportadora} ${s.cidade} ${s.tipo} ${s.observacoes}`.toUpperCase().includes(b));
}

// Sem botão próprio para "Resolvido": ele entra junto com os recebidos, que é
// o que o operador quer ver quando filtra o que já está tratado.
const PASSA_NO_STATUS = {
  todos: () => true,
  bateu: (r) => r.status === 'bateu' || r.status === 'resolvido',
  'nao-bipado': (r) => r.status === 'nao-bipado',
  qtd: (r) => r.qtdDiferente,
};

/** Linhas da aba atual com todos os filtros menos o de situação. */
function linhasBase() {
  if (estado.aba === 'sem-formulario') {
    return estado.cruzamento.semFormulario.filter(passaNaBusca);
  }
  return estado.cruzamento.produtos.filter((r) =>
    (!estado.transportadora || valoresDe(r, 'transportadora').includes(estado.transportadora)) &&
    (!estado.tipo || valoresDe(r, 'tipo').includes(estado.tipo)) &&
    passaNaBusca(r));
}

function linhasVisiveis() {
  let linhas = linhasBase();
  if (estado.aba === 'produtos') linhas = linhas.filter(PASSA_NO_STATUS[estado.status]);

  // Ordem de envio do formulário (mais recente primeiro), bipado ou não.
  const quando = (r) => r.envios[0]?.enviado_em || r.bipado?.entrada_em || '';
  return [...linhas].sort((a, b) =>
    quando(b).localeCompare(quando(a)) ||
    a.bruto.localeCompare(b.bruto, 'pt-BR', { numeric: true }));
}

function atualizarContagensStatus() {
  const base = estado.aba === 'produtos' ? linhasBase() : [];
  for (const [status, passa] of Object.entries(PASSA_NO_STATUS)) {
    const contador = el('f-' + status);
    if (contador) contador.textContent = String(base.filter(passa).length);
  }
  document.querySelectorAll('[data-status]').forEach((b) =>
    b.classList.toggle('ativo', b.dataset.status === estado.status));
}

/* --------------------------------------------------------------- colunas -- */

const ROTULO_STATUS = { bateu: 'Recebido', 'nao-bipado': 'Não recebido', resolvido: 'Resolvido' };
const ICONE_STATUS = { bateu: '✓ ', 'nao-bipado': '✗ ', resolvido: '● ' };

const qtdTexto = (r) => r.envios
  .map((s) => `${s.quantidade ?? '?'} / ${s.codigos.length} digitados`).join(' · ');

/**
 * Colunas de cada aba. `texto` serve para a tela e para o CSV; `celula`,
 * quando existe, monta uma célula mais rica só na tela.
 */
function colunas() {
  if (estado.aba === 'sem-formulario') {
    return [
      { titulo: 'Código bipado', texto: (r) => r.bruto, celula: celulaCodigo },
      { titulo: 'Bipado em', texto: (r) => formatar(r.bipado.entrada_em), classe: 'tl-c-data' },
      { titulo: 'Parecido com digitado', texto: (r) => r.parecidoCom || '', celula: celulaParecido, classe: 'tl-c-sugestao' },
    ];
  }

  return [
    { titulo: 'Situação', texto: (r) => ROTULO_STATUS[r.status], celula: celulaStatus, classe: 'tl-c-status' },
    { titulo: 'Código', texto: (r) => r.bruto, celula: celulaCodigo },
    { titulo: 'Parece ser', texto: (r) => r.sugestao?.codigo || '', soCsv: true },
    { titulo: 'Confirmado como', texto: (r) => r.confirmadoComo || '', soCsv: true },
    { titulo: 'Observação da resolução', texto: (r) => r.observacao || '', soCsv: true },
    { titulo: 'Enviado em', texto: (r) => r.envios.map((s) => formatar(s.enviado_em)).join(' · '), classe: 'tl-c-data' },
    { titulo: 'Bipado em', texto: (r) => formatar(r.bipado?.entrada_em || r.item?.entrada_em), classe: 'tl-c-data' },
    { titulo: 'Tipo', texto: (r) => valoresDe(r, 'tipo').join(' · ') },
    { titulo: 'Transportadora', texto: (r) => valoresDe(r, 'transportadora').join(' · ') },
    { titulo: 'Cidade', texto: (r) => valoresDe(r, 'cidade').join(' · ') },
    { titulo: 'Qtd informada', texto: qtdTexto, soCsv: true },
    { titulo: 'Observações', texto: (r) => valoresDe(r, 'observacoes').join(' · '), classe: 'tl-c-obs' },
  ];
}

function criar(tag, classe, texto) {
  const n = document.createElement(tag);
  if (classe) n.className = classe;
  if (texto !== undefined) n.textContent = texto;
  return n;
}

function pilulaStatus(r) {
  const p = criar('span', `tl-pilula tl-pilula-${r.status}`,
    ICONE_STATUS[r.status] + ROTULO_STATUS[r.status]);
  if (r.status === 'resolvido') {
    p.title = `Resolvido fora do sistema: ${r.observacao}`;
  } else if (r.confirmadoComo) {
    p.append(criar('small', '', ' confirmado'));
    p.title = `Digitado errado no formulário; confirmado como ${r.confirmadoComo}.`;
  } else if (r.status === 'bateu' && !r.bipado) {
    p.append(criar('small', '', ' no estoque'));
    p.title = 'Está no estoque, mas não foi bipado dentro do período escolhido.';
  }
  return p;
}

function celulaStatus(td, r) {
  td.append(pilulaStatus(r));
  if (r.observacao) {
    const obs = criar('div', 'tl-obs-resolvido', r.observacao);
    obs.title = r.observacao;
    td.append(obs);
  }
}

/** Botão "Confirmar" que não deixa o clique abrir o painel da linha. */
function botaoConfirmar(rotulo, digitado, codigo, classe = 'tl-confirmar') {
  const b = criar('button', classe, rotulo);
  b.type = 'button';
  b.title = `Confirmar que o código digitado é ${codigo}`;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    confirmarCodigo(digitado, codigo, b);
  });
  b.addEventListener('keydown', (e) => e.stopPropagation());
  return b;
}

function celulaCodigo(td, r) {
  td.classList.add('tl-c-codigo');
  td.append(criar('span', '', r.bruto));
  if (r.envios.length > 1) {
    td.append(criar('span', 'tl-selo', `${r.envios.length} formulários`));
  }
  if (r.sugestao) {
    const s = criar('div', 'tl-sugestao', 'parece ser ');
    s.append(criar('code', '', r.sugestao.codigo));
    if (!SO_LEITURA) s.append(botaoConfirmar('✓ Confirmar', r.chave, r.sugestao.codigo));
    td.append(s);
  }
  if (r.confirmadoComo) {
    const s = criar('div', 'tl-confirmado', 'confirmado como ');
    s.append(criar('code', '', r.confirmadoComo));
    td.append(s);
  }
}

function celulaParecido(td, r) {
  if (!r.parecidoCom) return;
  td.append(criar('span', '', r.parecidoCom));
  if (!SO_LEITURA) td.append(botaoConfirmar('✓ Confirmar', r.parecidoComChave, r.bruto));
}

/* ------------------------------------------------------------- renderizar - */

function renderizarCabecalho(cols) {
  const tr = document.createElement('tr');
  for (const col of cols) {
    if (col.soCsv) continue;
    tr.append(criar('th', col.classe || '', col.titulo));
  }
  ui.cabecalho.replaceChildren(tr);
}

function renderizarLinhas(linhas, cols) {
  const mostradas = linhas.slice(0, MAX_LINHAS_NA_TELA);

  const trs = mostradas.map((r) => {
    const tr = document.createElement('tr');
    tr.tabIndex = 0;
    if (estado.aba === 'produtos') {
      tr.className = `tl-linha-${r.status}` + (r.qtdDiferente ? ' tl-linha-qtd' : '');
    } else if (r.parecidoCom) {
      tr.className = 'tl-linha-parecido';
    }

    for (const col of cols) {
      if (col.soCsv) continue;
      const td = criar('td', col.classe || '');
      if (col.celula) col.celula(td, r);
      else td.textContent = col.texto(r);
      if (col.classe === 'tl-c-obs') td.title = td.textContent;
      tr.append(td);
    }

    tr.addEventListener('click', () => abrirPainel(r));
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') abrirPainel(r); });
    return tr;
  });

  ui.corpo.replaceChildren(...trs);
  return mostradas.length;
}

function renderizar() {
  document.querySelectorAll('.tl-aba').forEach((b) =>
    b.classList.toggle('ativo', b.dataset.aba === estado.aba));
  ui.filtrosProdutos.hidden = estado.aba !== 'produtos';
  atualizarContagensStatus();

  const cols = colunas();
  renderizarCabecalho(cols);

  const linhas = linhasVisiveis();
  const mostradas = renderizarLinhas(linhas, cols);

  const filtrando = estado.busca || estado.transportadora || estado.tipo ||
    (estado.aba === 'produtos' && estado.status !== 'todos');
  ui.vazio.hidden = linhas.length > 0;
  if (!linhas.length) {
    ui.vazio.textContent = filtrando
      ? 'Nenhum produto com esse filtro.'
      : estado.aba === 'produtos' ? 'Nenhum produto declarado no período.' : 'Nada pendente aqui. ✔';
  }

  const nome = (n) => (n === 1 ? 'produto' : 'produtos');
  ui.rodape.textContent = linhas.length > mostradas
    ? `Mostrando ${mostradas} de ${linhas.length} produtos. A exportação leva todos.`
    : linhas.length ? `${linhas.length} ${nome(linhas.length)}.` : '';
}

/* -------------------------------------------------------- painel lateral -- */

function campoPainel(rotulo, valor, classe) {
  const div = criar('div', 'tl-campo');
  div.append(criar('div', 'tl-campo-rotulo', rotulo));
  const v = criar('div', 'tl-campo-valor' + (classe ? ' ' + classe : ''), valor || '—');
  div.append(v);
  return div;
}

function blocoEnvio(s, chaveAberta) {
  const bloco = criar('section', 'tl-envio');
  bloco.append(criar('h3', '', `Formulário de ${formatar(s.enviado_em)}`));

  const grade = criar('div', 'tl-grade');
  grade.append(
    campoPainel('Tipo', s.tipo),
    campoPainel('Transportadora', s.transportadora),
    campoPainel('Cidade', s.cidade),
    campoPainel('Quantidade informada',
      s.quantidade === null ? '' : `${s.quantidade} (${s.codigos.length} digitados)`,
      s.qtdDiferente ? 'tl-c-qtd-alerta' : ''),
  );
  bloco.append(grade);
  if (s.observacoes) bloco.append(campoPainel('Observações', s.observacoes));

  const lista = criar('ul', 'tl-lista-codigos');
  for (const bruto of s.codigos) {
    const chave = normalizarCodigo(bruto);
    const linha = estado.cruzamento.linhaPorChave.get(chave);
    const li = criar('li', chave === chaveAberta ? 'tl-atual' : '');
    li.append(criar('code', '', bruto));
    if (linha) {
      li.append(pilulaStatus(linha));
      if (chave !== chaveAberta) {
        li.classList.add('tl-clicavel');
        li.addEventListener('click', () => abrirPainel(linha));
      }
    }
    lista.append(li);
  }
  bloco.append(criar('div', 'tl-campo-rotulo', `Códigos deste formulário (${s.codigos.length})`), lista);
  return bloco;
}

function abrirPainel(r) {
  ui.painelCodigo.replaceChildren(criar('span', '', r.bruto));
  if (r.status) ui.painelCodigo.append(pilulaStatus(r));

  const partes = [];

  const resumo = criar('div', 'tl-grade');
  const bipadoEm = r.bipado?.entrada_em || r.item?.entrada_em;
  resumo.append(campoPainel(r.bipado ? 'Bipado em' : 'Entrou no estoque em', formatar(bipadoEm)));
  if (r.sugestao) resumo.append(campoPainel('Parece ser', r.sugestao.codigo, 'tl-c-sugestao'));
  if (r.parecidoCom) resumo.append(campoPainel('Parecido com digitado', r.parecidoCom, 'tl-c-sugestao'));
  if (r.confirmadoComo) resumo.append(campoPainel('Confirmado como', r.confirmadoComo, 'tl-c-confirmado'));
  if (r.observacao) resumo.append(campoPainel('Resolvido — observação', r.observacao, 'tl-c-resolvido'));
  partes.push(resumo);

  // Ação principal do painel: confirmar o parecido, ou desfazer se já foi.
  const acao = criar('div', 'tl-painel-acao');
  if (r.sugestao) {
    acao.append(
      criar('p', '', `O entregador provavelmente digitou errado. Se o volume for mesmo ${r.sugestao.codigo}, confirme para contar como "Recebido".`),
      botaoConfirmar(`✓ Confirmar que é ${r.sugestao.codigo}`, r.chave, r.sugestao.codigo, 'tl-botao tl-botao-confirmar'));
  } else if (r.parecidoCom) {
    acao.append(
      criar('p', '', `O formulário tem ${r.parecidoCom}, que parece ser este volume digitado errado.`),
      botaoConfirmar(`✓ Confirmar que ${r.parecidoCom} é este volume`, r.parecidoComChave, r.bruto, 'tl-botao tl-botao-confirmar'));
  } else if (r.confirmadoComo) {
    const desfazer = criar('button', 'tl-botao', 'Desfazer confirmação');
    desfazer.type = 'button';
    desfazer.addEventListener('click', () => confirmarCodigo(r.chave, '', desfazer));
    acao.append(criar('p', '', `O código digitado ${r.bruto} foi confirmado como ${r.confirmadoComo}.`), desfazer);
  }
  if (acao.childElementCount && !SO_LEITURA && r.status !== 'resolvido') partes.push(acao);
  if (r.status === 'nao-bipado' && !r.confirmadoComo && !SO_LEITURA) partes.push(blocoRelacionar(r));
  if ((r.status === 'nao-bipado' || r.status === 'resolvido') && !SO_LEITURA) partes.push(blocoResolver(r));

  if (r.envios.length) {
    for (const s of r.envios) partes.push(blocoEnvio(s, r.chave));
  } else {
    partes.push(criar('p', 'tl-painel-nota',
      'Este volume foi bipado, mas nenhum formulário do Tally (nem dos 3 dias antes do período) cita esse código.'));
  }

  ui.painelCorpo.replaceChildren(...partes);
  ui.painelCorpo.scrollTop = 0;
  ui.painel.classList.add('aberto');
  ui.painel.setAttribute('aria-hidden', 'false');
  ui.painelFundo.hidden = false;
  ui.painel.focus();
}

const MAX_RELACIONAR_NA_TELA = 50;
const MAX_OBSERVACAO = 200;

/**
 * Marca à mão um "Não recebido" como resolvido fora do sistema. A observação
 * é obrigatória: é ela que conta, depois, por que aquele volume está tratado.
 */
function blocoResolver(r) {
  const bloco = criar('div', 'tl-painel-acao');
  const resolvido = r.status === 'resolvido';

  bloco.append(
    criar('h3', '', resolvido ? 'Resolvido fora do sistema' : 'Marcar como resolvido'),
    criar('p', '', resolvido
      ? 'Este volume não foi bipado, mas está tratado. Mude a observação ou desfaça a resolução.'
      : 'Se o volume não casa com nenhuma bipagem mas já foi tratado, escreva o que aconteceu e marque como resolvido.'));

  const campo = criar('input', 'tl-resolver-campo');
  campo.type = 'text';
  campo.maxLength = MAX_OBSERVACAO;
  campo.placeholder = 'O que aconteceu com este volume?';
  campo.value = r.observacao || '';

  const botao = criar('button', 'tl-botao tl-botao-resolver',
    resolvido ? '● Salvar observação' : '● Marcar como resolvido');
  botao.type = 'button';

  const enviar = () => {
    const observacao = campo.value.trim();
    if (!observacao) return campo.focus();
    resolverCodigo(r.chave, observacao, botao);
  };
  botao.addEventListener('click', enviar);
  campo.addEventListener('input', () => { botao.disabled = !campo.value.trim(); });
  campo.addEventListener('keydown', (e) => {
    e.stopPropagation();              // Esc/Enter aqui não mexem no painel
    if (e.key === 'Enter') enviar();
  });
  botao.disabled = !campo.value.trim();

  const linhaAcao = criar('div', 'tl-resolver-acoes');
  linhaAcao.append(botao);
  if (resolvido) {
    const desfazer = criar('button', 'tl-botao', 'Desfazer resolução');
    desfazer.type = 'button';
    desfazer.addEventListener('click', () => resolverCodigo(r.chave, '', desfazer));
    linhaAcao.append(desfazer);
  }

  bloco.append(campo, linhaAcao);
  return bloco;
}

/**
 * Casa à mão um código "Não recebido" com um bipado sem formulário. É o caso
 * do volume com mais de um código de barras: o entregador digitou um e o
 * estoque bipou o outro, então a sugestão por parecença nunca aparece.
 */
function blocoRelacionar(r) {
  const bloco = criar('div', 'tl-painel-acao');
  bloco.append(
    criar('h3', '', 'Relacionar com um código bipado'),
    criar('p', '', 'Se o formulário foi preenchido com outro código de barras do mesmo volume, escolha abaixo o código que foi bipado.'));

  // Bipes mais próximos do envio do formulário primeiro.
  const referencia = new Date(r.envios[0]?.enviado_em || Date.now()).getTime();
  const perto = (b) => Math.abs(new Date(b.bipado.entrada_em).getTime() - referencia);
  const candidatos = [...estado.cruzamento.semFormulario].sort((a, b) => perto(a) - perto(b));

  if (!candidatos.length) {
    bloco.append(criar('p', 'tl-painel-nota', 'Nenhum código bipado sem formulário no período.'));
    return bloco;
  }

  const busca = criar('input', 'tl-relacionar-busca');
  busca.type = 'search';
  busca.placeholder = 'Filtrar código bipado…';
  const lista = criar('ul', 'tl-relacionar-lista');
  const rodape = criar('p', 'tl-relacionar-rodape');

  const listar = () => {
    const termo = normalizarCodigo(busca.value);
    const achados = termo ? candidatos.filter((b) => b.chave.includes(termo)) : candidatos;
    const mostrados = achados.slice(0, MAX_RELACIONAR_NA_TELA);
    lista.replaceChildren(...mostrados.map((b) => {
      const li = criar('li');
      li.append(
        criar('code', '', b.bruto),
        criar('span', 'tl-relacionar-data', formatar(b.bipado.entrada_em)),
        botaoConfirmar('Relacionar', r.chave, b.bruto));
      return li;
    }));
    rodape.textContent = !achados.length ? 'Nenhum código com esse filtro.'
      : achados.length > mostrados.length ? `Mostrando ${mostrados.length} de ${achados.length}. Use o filtro.` : '';
  };
  busca.addEventListener('input', listar);
  listar();

  bloco.append(busca, lista, rodape);
  return bloco;
}

/**
 * Guarda no servidor que o código `digitado` (chave normalizada) é, na
 * verdade, `codigo`. Com `codigo` vazio, desfaz. Recalcula na hora, sem ir de
 * novo ao Tally.
 */
async function confirmarCodigo(digitado, codigo, botao) {
  botao.disabled = true;
  try {
    const r = await (await fetch('/api/tally/confirmar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ digitado, codigo }),
    })).json();
    if (!r.ok) {
      return mostrarErro(r.erro === 'rota_desconhecida'
        ? 'O servidor do estoque está desatualizado. Feche e abra o iniciar.bat de novo.'
        : r.erro === 'banco_fora_do_ar'
          ? 'Sem internet: a confirmação não foi salva. Tente de novo.'
          : 'Não foi possível salvar a confirmação.');
    }

    mostrarErro('');
    const painelAberto = ui.painel.classList.contains('aberto');
    estado.dados.confirmacoes = r.confirmacoes;
    estado.cruzamento = cruzar(estado.dados);
    renderizarResumo();
    renderizarAvisos();
    renderizar();

    const linha = estado.cruzamento.linhaPorChave.get(digitado);
    if (painelAberto && linha) abrirPainel(linha);
  } catch {
    mostrarErro('Erro de conexão com o servidor. O painel ainda está ligado?');
  } finally {
    botao.disabled = false;
  }
}

/**
 * Guarda no servidor que o código `digitado` (chave normalizada) está
 * resolvido fora do sistema, com a observação do operador. Observação vazia
 * desfaz. Recalcula na hora, sem ir de novo ao Tally.
 */
async function resolverCodigo(digitado, observacao, botao) {
  botao.disabled = true;
  try {
    const r = await (await fetch('/api/tally/resolver', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ digitado, observacao }),
    })).json();
    if (!r.ok) {
      return mostrarErro(r.erro === 'rota_desconhecida'
        ? 'O servidor do estoque está desatualizado. Feche e abra o iniciar.bat de novo.'
        : r.erro === 'banco_fora_do_ar'
          ? 'Sem internet: a resolução não foi salva. Tente de novo.'
          : 'Não foi possível salvar a resolução.');
    }

    mostrarErro('');
    const painelAberto = ui.painel.classList.contains('aberto');
    estado.dados.resolvidos = r.resolvidos;
    estado.cruzamento = cruzar(estado.dados);
    renderizarResumo();
    renderizarAvisos();
    renderizar();

    const linha = estado.cruzamento.linhaPorChave.get(digitado);
    if (painelAberto && linha) abrirPainel(linha);
  } catch {
    mostrarErro('Erro de conexão com o servidor. O painel ainda está ligado?');
  } finally {
    botao.disabled = false;
  }
}

function fecharPainel() {
  ui.painel.classList.remove('aberto');
  ui.painel.setAttribute('aria-hidden', 'true');
  ui.painelFundo.hidden = true;
}

/* -------------------------------------------------------------- exportar -- */

function paraCsv(valor) {
  const s = String(valor ?? '');
  return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function exportar() {
  const cols = colunas();
  const linhas = linhasVisiveis();

  const texto = [
    cols.map((c) => paraCsv(c.titulo)).join(';'),
    ...linhas.map((r) => cols.map((c) => paraCsv(c.texto(r))).join(';')),
  ].join('\r\n');

  // BOM + separador ';' para o Excel pt-BR abrir com acento e colunas certas.
  const bom = String.fromCharCode(0xfeff);
  const blob = new Blob([bom + texto], { type: 'text/csv;charset=utf-8' });

  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tally-${estado.aba}-${ui.inpDe.value}_${ui.inpAte.value}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* --------------------------------------------------------------- eventos -- */

ui.btnAtualizar?.addEventListener('click', atualizar);

// Sem botão Atualizar (consulta): busca sozinho ao trocar a data. A espera
// evita uma busca no Tally a cada parte da data digitada.
if (!ui.btnAtualizar) {
  let cronoPeriodo = null;
  for (const inp of [ui.inpDe, ui.inpAte]) {
    inp.addEventListener('change', () => {
      clearTimeout(cronoPeriodo);
      cronoPeriodo = setTimeout(atualizar, 600);
    });
  }
}
ui.btnSalvarChave?.addEventListener('click', salvarChave);
ui.inpChave?.addEventListener('keydown', (e) => { if (e.key === 'Enter') salvarChave(); });

document.querySelectorAll('.tl-aba').forEach((botao) => {
  botao.addEventListener('click', () => {
    estado.aba = botao.dataset.aba;
    renderizar();
  });
});

document.querySelectorAll('[data-status]').forEach((botao) => {
  botao.addEventListener('click', () => {
    estado.status = botao.dataset.status;
    renderizar();
  });
});

ui.selTransportadora.addEventListener('change', () => {
  estado.transportadora = ui.selTransportadora.value;
  renderizar();
});
ui.selTipo?.addEventListener('change', () => {
  estado.tipo = ui.selTipo.value;
  renderizar();
});

ui.btnAlertas.addEventListener('click', () => {
  ui.avisos.hidden = !ui.avisos.hidden;
  ui.btnAlertas.classList.toggle('ativo', !ui.avisos.hidden);
});

let cronoBusca = null;
ui.busca.addEventListener('input', () => {
  clearTimeout(cronoBusca);
  cronoBusca = setTimeout(() => { estado.busca = ui.busca.value.trim(); renderizar(); }, 200);
});

ui.btnExportar.addEventListener('click', exportar);

ui.painelFechar.addEventListener('click', fecharPainel);
ui.painelFundo.addEventListener('click', fecharPainel);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && ui.painel.classList.contains('aberto')) fecharPainel();
});

aplicarPeriodoPadrao();
verificarChave().then((temChave) => { if (temChave) atualizar(); });
