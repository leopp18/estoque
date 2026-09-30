'use strict';

/* ==========================================================================
   Conferência: cruza a planilha do Power BI com o estoque.

   O servidor só interpreta o arquivo. O cruzamento, os filtros e a exportação
   acontecem aqui, sobre dados já carregados — trocar a coluna de código ou
   filtrar por tratativa é instantâneo, sem reenviar nada.
   ========================================================================== */

const MAX_LINHAS_NA_TELA = 1000;

const el = (id) => document.getElementById(id);

const ui = {
  areaImportar: el('area-importar'),
  areaMapa: el('area-mapa'),
  areaResultado: el('area-resultado'),
  alvo: el('alvo'),
  arquivo: el('arquivo'),
  btnEscolher: el('btn-escolher'),
  btnTrocar: el('btn-trocar'),
  importarErro: el('importar-erro'),
  mapaNome: el('mapa-nome'),
  mapaInfo: el('mapa-info'),
  campoAba: el('campo-aba'),
  selAba: el('sel-aba'),
  selCodigo: el('sel-codigo'),
  selTratativa: el('sel-tratativa'),
  dicaCodigo: el('dica-codigo'),
  dicaTratativa: el('dica-tratativa'),
  chkZeros: el('chk-zeros'),
  avisos: el('avisos'),
  resumo: el('resumo'),
  cabecalho: el('cabecalho'),
  corpo: el('corpo'),
  vazio: el('vazio'),
  rodape: el('rodape'),
  busca: el('busca'),
  selOrdem: el('sel-ordem'),
  btnExportar: el('btn-exportar'),
  cEstoque: el('c-estoque'),
};

const estado = {
  estoque: [],          // [{codigo, entrada_em}]
  porCodigo: new Map(), // código normalizado -> item do estoque
  tabela: null,         // {colunas, linhas, abas, aba, nome}
  bytes: null,          // arquivo original, para reler outra aba
  nomeArquivo: '',
  colCodigo: -1,
  colTratativa: -1,
  ignorarZeros: false,
  grupo: 'ambos',
  filtroTratativa: null,
  busca: '',
  ordem: 'tratativa',
  cruzamento: null,
};

/* ------------------------------------------------------- normalização ---- */

// normalizarCodigo() e ehCientifica() vêm de normalizar.js.
const normalizar = (bruto, ignorarZeros = estado.ignorarZeros) =>
  normalizarCodigo(bruto, ignorarZeros);

/* ------------------------------------------------------------- estoque --- */

async function carregarEstoque() {
  const resposta = await fetch('/api/codigos');
  const dados = await resposta.json();
  estado.estoque = dados.codigos || [];
  reindexarEstoque();
  ui.cEstoque.textContent = String(estado.estoque.length);
}

function reindexarEstoque() {
  estado.porCodigo = new Map();
  for (const item of estado.estoque) {
    const chave = normalizar(item.codigo);
    if (chave) estado.porCodigo.set(chave, item);
  }
}

/* ----------------------------------------------------------- importação -- */

function mostrarErro(mensagem) {
  ui.importarErro.textContent = mensagem;
  ui.importarErro.hidden = false;
}

async function enviarPlanilha(dados, nome, aba = null) {
  ui.importarErro.hidden = true;
  ui.alvo.classList.add('ocupado');
  ui.alvo.querySelector('.alvo-titulo').textContent = 'Lendo a planilha…';

  try {
    const cabecalhos = { 'Content-Type': 'application/octet-stream' };
    if (nome) cabecalhos['X-Nome-Arquivo'] = encodeURIComponent(nome);
    if (aba) cabecalhos['X-Aba'] = encodeURIComponent(aba);

    const resposta = await fetch('/api/planilha', {
      method: 'POST', headers: cabecalhos, body: dados,
    });
    const r = await resposta.json();

    if (!r.ok) {
      mostrarErro(
        r.mensagem ||
        (r.erro === 'arquivo_grande_demais'
          ? 'Arquivo maior que 40 MB.'
          : r.erro === 'arquivo_vazio'
            ? 'O arquivo chegou vazio.'
            : 'Não foi possível ler essa planilha.')
      );
      return;
    }

    if (!r.linhas.length) {
      mostrarErro('A planilha foi lida, mas não tem nenhuma linha de dados.');
      return;
    }

    estado.tabela = r;
    estado.nomeArquivo = nome || 'colado do Excel';
    estado.bytes = dados;
    aoCarregarTabela();
  } catch (e) {
    mostrarErro('Erro de conexão com o servidor. O painel ainda está ligado?');
  } finally {
    ui.alvo.classList.remove('ocupado');
    ui.alvo.querySelector('.alvo-titulo').textContent = 'Arraste aqui a planilha do Power BI';
  }
}

async function receberArquivo(file) {
  if (!file) return;
  await enviarPlanilha(await file.arrayBuffer(), file.name);
}

/* --------------------------------------------------- detecção de coluna -- */

const RE_NOME_TRATATIVA = /situa|status|tratativ|destino|a[cç][aã]o|providen|resolu|encaminh|motivo/i;
const RE_NOME_CODIGO = /c[oó]digo|volume|barra|etiqueta|sscc|objeto|pacote|remessa/i;

/**
 * Testa cada coluna contra o estoque e escolhe a que mais bate. É melhor que
 * adivinhar pelo nome do cabeçalho: funciona mesmo se o PBI mudar o rótulo.
 */
function avaliarColunas() {
  const { colunas, linhas } = estado.tabela;
  return colunas.map((nome, i) => {
    const distintos = new Set();
    let acertos = 0;
    for (const linha of linhas) {
      const chave = normalizar(linha[i]);
      if (!chave || distintos.has(chave)) continue;
      distintos.add(chave);
      if (estado.porCodigo.has(chave)) acertos++;
    }
    return { i, nome, distintos: distintos.size, acertos };
  });
}

function detectarColunaCodigo(avaliacao) {
  const melhor = avaliacao.reduce((a, b) => (b.acertos > a.acertos ? b : a), avaliacao[0]);
  if (melhor.acertos > 0) return melhor.i;

  // Estoque vazio ou nenhum acerto: cai para o nome do cabeçalho.
  const porNome = avaliacao.find((c) => RE_NOME_CODIGO.test(c.nome));
  if (porNome) return porNome.i;

  // Último recurso: a coluna com mais valores distintos (parece um id).
  return avaliacao.reduce((a, b) => (b.distintos > a.distintos ? b : a), avaliacao[0]).i;
}

/**
 * Coluna de status tem poucos valores distintos, muito repetidos. Tenta pelo
 * nome primeiro; se não achar, usa essa assinatura.
 */
function detectarColunaTratativa(avaliacao, iCodigo) {
  const candidatas = avaliacao.filter((c) => c.i !== iCodigo);
  if (!candidatas.length) return -1;

  const porNome = candidatas.find((c) => RE_NOME_TRATATIVA.test(c.nome));
  if (porNome) return porNome.i;

  const totalLinhas = estado.tabela.linhas.length;
  const repetidas = candidatas
    .filter((c) => c.distintos >= 2 && c.distintos <= 30 && c.distintos * 2 <= totalLinhas)
    .sort((a, b) => a.distintos - b.distintos);

  return repetidas.length ? repetidas[0].i : candidatas[0].i;
}

/* ----------------------------------------- memória das colunas escolhidas - */

const chaveLayout = () => 'conf:' + (estado.tabela?.colunas.join('|') || '');

function lembrarColunas() {
  try {
    localStorage.setItem(chaveLayout(), JSON.stringify({
      codigo: estado.tabela.colunas[estado.colCodigo],
      tratativa: estado.tabela.colunas[estado.colTratativa],
    }));
  } catch { /* navegador sem armazenamento: seguir sem lembrar */ }
}

function recuperarColunas() {
  try {
    const bruto = localStorage.getItem(chaveLayout());
    if (!bruto) return null;
    const { codigo, tratativa } = JSON.parse(bruto);
    return {
      codigo: estado.tabela.colunas.indexOf(codigo),
      tratativa: estado.tabela.colunas.indexOf(tratativa),
    };
  } catch { return null; }
}

/* ---------------------------------------------------- ao carregar tabela -- */

function aoCarregarTabela() {
  const avaliacao = avaliarColunas();
  const lembrado = recuperarColunas();

  estado.colCodigo = lembrado && lembrado.codigo >= 0
    ? lembrado.codigo
    : detectarColunaCodigo(avaliacao);

  estado.colTratativa = lembrado && lembrado.tratativa >= 0
    ? lembrado.tratativa
    : detectarColunaTratativa(avaliacao, estado.colCodigo);

  preencherSeletores();
  ui.areaImportar.hidden = true;
  ui.areaMapa.hidden = false;
  ui.areaResultado.hidden = false;

  ui.mapaNome.textContent = estado.nomeArquivo;
  ui.mapaInfo.textContent =
    `${estado.tabela.linhas.length} linhas · ${estado.tabela.colunas.length} colunas`;

  const abas = estado.tabela.abas || [];
  ui.campoAba.hidden = abas.length < 2;
  if (abas.length >= 2) {
    ui.selAba.replaceChildren(...abas.map((a) => new Option(a, a, false, a === estado.tabela.aba)));
  }

  recalcular();
}

function preencherSeletores() {
  const opcoes = (selecionado) =>
    estado.tabela.colunas.map((c, i) => new Option(c, String(i), false, i === selecionado));

  ui.selCodigo.replaceChildren(...opcoes(estado.colCodigo));
  ui.selTratativa.replaceChildren(
    new Option('— nenhuma —', '-1', false, estado.colTratativa === -1),
    ...opcoes(estado.colTratativa)
  );
}

/* ------------------------------------------------------------ cruzamento -- */

function cruzar() {
  const { linhas } = estado.tabela;
  const iCod = estado.colCodigo;
  const iTrat = estado.colTratativa;

  const doPbi = new Map();   // código normalizado -> registro agrupado
  let semCodigo = 0;
  let convertidos = 0;

  for (const linha of linhas) {
    const bruto = linha[iCod];
    const chave = normalizar(bruto);
    if (!chave) { semCodigo++; continue; }
    if (ehCientifica(bruto)) convertidos++;

    let reg = doPbi.get(chave);
    if (!reg) {
      reg = { chave, bruto: String(bruto).trim(), tratativas: [], linhas: [] };
      doPbi.set(chave, reg);
    }
    reg.linhas.push(linha);

    const trat = iTrat >= 0 ? String(linha[iTrat] ?? '').trim() : '';
    const rotulo = trat || '(sem tratativa)';
    if (!reg.tratativas.includes(rotulo)) reg.tratativas.push(rotulo);
  }

  const ambos = [];
  const soPbi = [];

  for (const reg of doPbi.values()) {
    const item = estado.porCodigo.get(reg.chave);
    const registro = {
      ...reg,
      item: item || null,
      conflito: reg.tratativas.length > 1,
      repetido: reg.linhas.length > 1,
    };
    if (item) ambos.push(registro);
    else soPbi.push(registro);
  }

  const noPbi = new Set(doPbi.keys());
  const soEstoque = estado.estoque
    .filter((i) => !noPbi.has(normalizar(i.codigo)))
    .map((item) => ({
      chave: normalizar(item.codigo),
      bruto: item.codigo,
      tratativas: [],
      linhas: [],
      item,
      conflito: false,
      repetido: false,
    }));

  return { ambos, soPbi, soEstoque, semCodigo, convertidos, totalPbi: doPbi.size };
}

function recalcular() {
  estado.cruzamento = cruzar();
  estado.filtroTratativa = null;
  atualizarDicas();
  atualizarAvisos();
  renderizar();
}

function atualizarDicas() {
  const { ambos, soPbi, totalPbi } = estado.cruzamento;
  const acertos = ambos.length;

  ui.dicaCodigo.textContent =
    `${acertos} de ${totalPbi} códigos batem com o estoque`;
  ui.dicaCodigo.className = acertos === 0 ? 'ruim' : acertos >= totalPbi / 2 ? 'bom' : '';

  if (estado.colTratativa === -1) {
    ui.dicaTratativa.textContent = 'sem coluna de tratativa';
    ui.dicaTratativa.className = '';
  } else {
    const distintas = new Set();
    for (const r of [...ambos, ...soPbi]) r.tratativas.forEach((t) => distintas.add(t));
    ui.dicaTratativa.textContent = `${distintas.size} tratativas diferentes`;
    ui.dicaTratativa.className = distintas.size > 40 ? 'ruim' : 'bom';
  }
}

function atualizarAvisos() {
  const { convertidos, semCodigo, ambos, totalPbi } = estado.cruzamento;
  const avisos = [];

  if (convertidos) {
    avisos.push(
      `${convertidos} código(s) do arquivo vieram em notação científica ` +
      `(ex: 7,89123E+12) e foram convertidos de volta para comparar.`
    );
  }
  if (semCodigo) {
    avisos.push(`${semCodigo} linha(s) do arquivo estão sem código e foram ignoradas.`);
  }
  if (totalPbi > 0 && ambos.length === 0) {
    avisos.push(
      'Nenhum código da planilha bate com o estoque. Confira se a coluna do ' +
      'código está certa, ou tente marcar "ignorar zeros à esquerda".'
    );
  }

  ui.avisos.replaceChildren(...avisos.map((texto) => {
    const div = document.createElement('div');
    div.className = 'aviso';
    div.textContent = texto;
    return div;
  }));
}

/* ------------------------------------------------------------- renderizar - */

const fmtData = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

const formatar = (iso) => (iso ? fmtData.format(new Date(iso)) : '');

const gruposDoEstado = () => ({
  ambos: estado.cruzamento.ambos,
  'so-pbi': estado.cruzamento.soPbi,
  'so-estoque': estado.cruzamento.soEstoque,
});

// Sem saída, um código do PBI ou está no estoque (grupo "ambos") ou nunca foi
// bipado — não há estado intermediário para descrever.
const SITUACAO_FORA_DO_ESTOQUE = 'nunca foi bipado';

function colunasExtras() {
  if (estado.grupo === 'so-estoque') return [];
  return estado.tabela.colunas
    .map((nome, i) => ({ nome, i }))
    .filter((c) => c.i !== estado.colCodigo && c.i !== estado.colTratativa);
}

function linhasVisiveis() {
  let linhas = gruposDoEstado()[estado.grupo] || [];

  if (estado.filtroTratativa === '__conflito__') {
    linhas = linhas.filter((r) => r.conflito);
  } else if (estado.filtroTratativa) {
    linhas = linhas.filter((r) => r.tratativas.includes(estado.filtroTratativa));
  }

  if (estado.busca) {
    const b = estado.busca.toUpperCase();
    linhas = linhas.filter((r) => r.bruto.toUpperCase().includes(b) || r.chave.includes(b));
  }

  const ordenadores = {
    codigo: (a, b) => a.bruto.localeCompare(b.bruto, 'pt-BR', { numeric: true }),
    entrada: (a, b) => String(b.item?.entrada_em ?? '').localeCompare(String(a.item?.entrada_em ?? '')),
    tratativa: (a, b) =>
      (a.tratativas[0] || '').localeCompare(b.tratativas[0] || '', 'pt-BR') ||
      a.bruto.localeCompare(b.bruto, 'pt-BR', { numeric: true }),
  };

  return [...linhas].sort(ordenadores[estado.ordem] || ordenadores.tratativa);
}

function renderizarResumo() {
  const grupo = gruposDoEstado()[estado.grupo] || [];

  if (estado.grupo === 'so-estoque' || estado.colTratativa === -1) {
    ui.resumo.replaceChildren();
    return;
  }

  const contagem = new Map();
  let conflitos = 0;
  for (const r of grupo) {
    if (r.conflito) conflitos++;
    for (const t of r.tratativas) contagem.set(t, (contagem.get(t) || 0) + 1);
  }

  const blocos = [];

  if (conflitos) {
    blocos.push(criarBloco('__conflito__', '⚠ Conflito', conflitos, true));
  }

  for (const [tratativa, n] of [...contagem.entries()].sort((a, b) => b[1] - a[1])) {
    blocos.push(criarBloco(tratativa, tratativa, n, false));
  }

  ui.resumo.replaceChildren(...blocos);
}

function criarBloco(valor, rotulo, n, ehConflito) {
  const botao = document.createElement('button');
  botao.type = 'button';
  botao.className = 'bloco' + (ehConflito ? ' bloco-conflito' : '') +
    (estado.filtroTratativa === valor ? ' ativo' : '');

  const num = document.createElement('span');
  num.className = 'bloco-n';
  num.textContent = String(n);

  const texto = document.createElement('span');
  texto.textContent = rotulo;

  botao.append(num, texto);
  botao.addEventListener('click', () => {
    estado.filtroTratativa = estado.filtroTratativa === valor ? null : valor;
    renderizar();
  });
  return botao;
}

function renderizarCabecalho() {
  const tr = document.createElement('tr');
  const nomes = ['Código'];

  if (estado.grupo === 'so-pbi') nomes.push('Situação');
  else nomes.push('Entrada no estoque');

  if (estado.grupo !== 'so-estoque' && estado.colTratativa >= 0) nomes.push('Tratativa');

  for (const c of colunasExtras()) nomes.push(c.nome);

  for (const nome of nomes) {
    const th = document.createElement('th');
    th.textContent = nome;
    tr.append(th);
  }
  ui.cabecalho.replaceChildren(tr);
}

function renderizarLinhas(linhas) {
  const extras = colunasExtras();
  const mostradas = linhas.slice(0, MAX_LINHAS_NA_TELA);

  const trs = mostradas.map((r) => {
    const tr = document.createElement('tr');
    if (r.conflito) tr.className = 'conflito';

    const tdCodigo = document.createElement('td');
    tdCodigo.className = 'celula-codigo';
    tdCodigo.textContent = r.bruto;
    if (r.repetido) {
      const selo = document.createElement('span');
      selo.className = 'selo-conflito';
      selo.textContent = r.conflito
        ? `⚠ ${r.tratativas.length} tratativas`
        : `${r.linhas.length} linhas`;
      if (!r.conflito) selo.style.background = 'var(--neutro)';
      tdCodigo.append(selo);
    }
    tr.append(tdCodigo);

    const tdSit = document.createElement('td');
    tdSit.className = 'celula-data';
    tdSit.textContent = estado.grupo === 'so-pbi'
      ? SITUACAO_FORA_DO_ESTOQUE
      : formatar(r.item?.entrada_em);
    tr.append(tdSit);

    if (estado.grupo !== 'so-estoque' && estado.colTratativa >= 0) {
      const tdTrat = document.createElement('td');
      for (const t of r.tratativas) {
        const span = document.createElement('span');
        span.className = 'etiqueta-tratativa';
        span.textContent = t;
        span.style.marginRight = '6px';
        tdTrat.append(span);
      }
      tr.append(tdTrat);
    }

    for (const c of extras) {
      const td = document.createElement('td');
      td.className = 'celula-extra';
      const valores = [...new Set(r.linhas.map((l) => String(l[c.i] ?? '').trim()))]
        .filter(Boolean);
      td.textContent = valores.join(' · ');
      td.title = td.textContent;
      tr.append(td);
    }

    return tr;
  });

  ui.corpo.replaceChildren(...trs);
  return mostradas.length;
}

function renderizar() {
  const { ambos, soPbi, soEstoque } = estado.cruzamento;
  el('n-ambos').textContent = String(ambos.length);
  el('n-so-pbi').textContent = String(soPbi.length);
  el('n-so-estoque').textContent = String(soEstoque.length);

  renderizarResumo();
  renderizarCabecalho();

  const linhas = linhasVisiveis();
  const mostradas = renderizarLinhas(linhas);

  ui.vazio.hidden = linhas.length > 0;
  if (!linhas.length) {
    ui.vazio.textContent = estado.busca || estado.filtroTratativa
      ? 'Nenhum volume com esse filtro.'
      : 'Nenhum volume neste grupo.';
  }

  ui.rodape.textContent = linhas.length > mostradas
    ? `Mostrando ${mostradas} de ${linhas.length} volumes — use a busca ou os filtros. ` +
      `A exportação leva todos os ${linhas.length}.`
    : linhas.length
      ? `${linhas.length} ${linhas.length === 1 ? 'volume' : 'volumes'}.`
      : '';
}

/* -------------------------------------------------------------- exportar -- */

function paraCsv(valor) {
  const s = String(valor ?? '');
  return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function exportar() {
  const linhas = linhasVisiveis();
  const extras = colunasExtras();

  const cabecalho = ['Codigo'];
  cabecalho.push(estado.grupo === 'so-pbi' ? 'Situacao' : 'Entrada no estoque');
  if (estado.grupo !== 'so-estoque' && estado.colTratativa >= 0) cabecalho.push('Tratativa');
  for (const c of extras) cabecalho.push(c.nome);

  const corpo = linhas.map((r) => {
    const campos = [r.bruto];
    campos.push(estado.grupo === 'so-pbi'
      ? SITUACAO_FORA_DO_ESTOQUE
      : formatar(r.item?.entrada_em));
    if (estado.grupo !== 'so-estoque' && estado.colTratativa >= 0) {
      campos.push(r.tratativas.join(' | '));
    }
    for (const c of extras) {
      const valores = [...new Set(r.linhas.map((l) => String(l[c.i] ?? '').trim()))].filter(Boolean);
      campos.push(valores.join(' | '));
    }
    return campos.map(paraCsv).join(';');
  });

  // BOM + separador ';' para o Excel pt-BR abrir com acento e colunas certas.
  const texto = '﻿' + [cabecalho.map(paraCsv).join(';'), ...corpo].join('\r\n');
  const blob = new Blob([texto], { type: 'text/csv;charset=utf-8' });

  const nomes = { ambos: 'no-estoque', 'so-pbi': 'fora-do-estoque', 'so-estoque': 'sem-tratativa' };
  const data = new Date().toISOString().slice(0, 10);

  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `conferencia-${nomes[estado.grupo]}-${data}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* --------------------------------------------------------------- eventos -- */

ui.btnEscolher.addEventListener('click', (e) => { e.stopPropagation(); ui.arquivo.click(); });
ui.alvo.addEventListener('click', () => ui.arquivo.click());
ui.arquivo.addEventListener('change', () => receberArquivo(ui.arquivo.files[0]));

for (const evento of ['dragenter', 'dragover']) {
  window.addEventListener(evento, (e) => {
    e.preventDefault();
    if (!ui.areaImportar.hidden) ui.alvo.classList.add('arrastando');
  });
}
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) ui.alvo.classList.remove('arrastando');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  ui.alvo.classList.remove('arrastando');
  const file = e.dataTransfer?.files?.[0];
  if (file) {
    if (!ui.areaImportar.hidden) receberArquivo(file);
    else if (confirm('Trocar pela planilha arrastada?')) receberArquivo(file);
  }
});

// Colar direto do Excel: o conteúdo vem como texto separado por tabulação.
window.addEventListener('paste', (e) => {
  const alvo = document.activeElement;
  if (alvo && (alvo.tagName === 'INPUT' || alvo.tagName === 'TEXTAREA')) return;

  const texto = e.clipboardData?.getData('text/plain');
  if (!texto || !texto.trim()) return;
  e.preventDefault();
  enviarPlanilha(new Blob([texto], { type: 'text/plain' }), '');
});

ui.btnTrocar.addEventListener('click', () => {
  ui.areaImportar.hidden = false;
  ui.areaMapa.hidden = true;
  ui.areaResultado.hidden = true;
  ui.arquivo.value = '';
});

ui.selCodigo.addEventListener('change', () => {
  estado.colCodigo = Number(ui.selCodigo.value);
  if (estado.colTratativa === estado.colCodigo) estado.colTratativa = -1;
  preencherSeletores();
  lembrarColunas();
  recalcular();
});

ui.selTratativa.addEventListener('change', () => {
  estado.colTratativa = Number(ui.selTratativa.value);
  lembrarColunas();
  recalcular();
});

ui.selAba.addEventListener('change', () => {
  if (estado.bytes) enviarPlanilha(estado.bytes, estado.nomeArquivo, ui.selAba.value);
});

ui.chkZeros.addEventListener('change', () => {
  estado.ignorarZeros = ui.chkZeros.checked;
  reindexarEstoque();
  recalcular();
});

document.querySelectorAll('.grupo').forEach((botao) => {
  botao.addEventListener('click', () => {
    document.querySelectorAll('.grupo').forEach((b) => b.classList.remove('ativo'));
    botao.classList.add('ativo');
    estado.grupo = botao.dataset.grupo;
    estado.filtroTratativa = null;
    renderizar();
  });
});

let cronoBusca = null;
ui.busca.addEventListener('input', () => {
  clearTimeout(cronoBusca);
  cronoBusca = setTimeout(() => { estado.busca = ui.busca.value.trim(); renderizar(); }, 200);
});

ui.selOrdem.addEventListener('change', () => {
  estado.ordem = ui.selOrdem.value;
  renderizar();
});

ui.btnExportar.addEventListener('click', exportar);

carregarEstoque().catch(() => {
  mostrarErro('Não consegui falar com o servidor do estoque. O painel está ligado?');
});
