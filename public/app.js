'use strict';

/* ==========================================================================
   Painel de Estoque - leitura continua com leitor de codigo de barras.

   O leitor USB se comporta como teclado: digita o codigo e manda Enter.
   Por isso a captura e feita no DOCUMENTO inteiro, e nao num <input> focado:
   assim clicar em qualquer lugar da tela nao interrompe a sequencia de leitura.
   ========================================================================== */

const MS_FIM_LEITURA = 120;   // silencio que encerra o codigo quando nao vem Enter
const MIN_SEM_ENTER = 4;      // tamanho minimo aceito sem Enter
const MS_DUPLICATA = 800;     // mesma etiqueta lida de novo antes disso = disparo duplo
const MS_POLL = 20000;        // atualizacao de fundo (outro dispositivo escaneando)

const el = (id) => document.getElementById(id);

const ui = {
  corpo: el('corpo-tabela'),
  vazio: el('vazio'),
  rodape: el('rodape-lista'),
  faixa: el('faixa'),
  faixaIcone: el('faixa-icone'),
  faixaTitulo: el('faixa-titulo'),
  faixaCodigo: el('faixa-codigo'),
  btnEntrada: el('btn-entrada'),
  btnDesfazer: el('btn-desfazer'),
  busca: el('busca'),
  dica: el('dica-scanner'),
  cGuardados: el('c-guardados'),
  cSessao: el('c-sessao'),
};

const estado = {
  ligado: false,         // ENTRADA ativada: so entao a leitura grava
  busca: '',
  sessao: 0,             // leituras gravadas desde que a pagina abriu
  ultimoId: null,        // id da ultima entrada, para o desfazer
  ultimaLeitura: { codigo: null, quando: 0 },
  ultimoScanEm: 0,
  truncada: false,       // a lista mostrada foi cortada pelo limite do servidor
};

/* ---------------------------------------------------------------- som ---- */

let audio = null;

function destravarAudio() {
  if (!audio) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audio = new AC();
  }
  if (audio && audio.state === 'suspended') audio.resume();
}

function bip(freq, duracao, volume = 0.16, atraso = 0) {
  if (!audio) return;
  const inicio = audio.currentTime + atraso;
  const osc = audio.createOscillator();
  const ganho = audio.createGain();
  osc.type = 'square';
  osc.frequency.value = freq;
  ganho.gain.setValueAtTime(0, inicio);
  ganho.gain.linearRampToValueAtTime(volume, inicio + 0.008);
  ganho.gain.setValueAtTime(volume, inicio + duracao - 0.02);
  ganho.gain.linearRampToValueAtTime(0, inicio + duracao);
  osc.connect(ganho).connect(audio.destination);
  osc.start(inicio);
  osc.stop(inicio + duracao + 0.02);
}

const som = {
  entrada: () => bip(1180, 0.09),
  erro: () => { bip(200, 0.16, 0.2); bip(200, 0.16, 0.2, 0.2); },
  ignorada: () => bip(520, 0.04, 0.05),
};

/* -------------------------------------------------------------- faixa ---- */

function mostrarFaixa(classe, icone, titulo, codigo = '') {
  ui.faixa.className = 'faixa ' + classe;
  ui.faixaIcone.textContent = icone;
  ui.faixaTitulo.textContent = titulo;
  ui.faixaCodigo.textContent = codigo;
  // reinicia a animacao de piscada
  ui.faixa.classList.remove('faixa-pisca');
  void ui.faixa.offsetWidth;
  ui.faixa.classList.add('faixa-pisca');
}

/* -------------------------------------------------------------- ligar ---- */

// A leitura so grava depois que ENTRADA e ativada. Alem de ser a trava contra
// digitacao acidental no teclado, esse clique e o gesto que o navegador exige
// para liberar o audio dos bipes.
function ligar() {
  destravarAudio();
  estado.ligado = true;
  document.body.dataset.modo = 'entrada';
  ui.btnEntrada.setAttribute('aria-pressed', 'true');
  mostrarFaixa('faixa-entrada', '\u{1F4E5}', 'MODO ENTRADA — pode escanear');
  bip(1180, 0.06, 0.1);
  atualizarDica();
}

function atualizarDica(texto = null, destacada = false) {
  if (texto !== null) {
    ui.dica.textContent = texto;
    ui.dica.classList.toggle('digitando', destacada);
    return;
  }
  ui.dica.classList.remove('digitando');
  if (document.activeElement === ui.busca) {
    ui.dica.textContent =
      'Leitura pausada enquanto você digita na busca — pressione Esc para voltar a ler.';
  } else if (!estado.ligado) {
    ui.dica.textContent =
      'Leitura desligada — clique em ENTRADA (ou use F2) para liberar a leitura.';
  } else {
    ui.dica.textContent =
      'Leitura contínua ativa — escaneie em sequência, sem clicar em nada.';
  }
}

/* ------------------------------------------------- captura do leitor ---- */

let buffer = '';
let cronometro = null;

function digitandoEmCampo() {
  const a = document.activeElement;
  if (!a) return false;
  const tag = a.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || a.isContentEditable;
}

function limparBuffer() {
  buffer = '';
  clearTimeout(cronometro);
  cronometro = null;
  atualizarDica();
}

function fecharPorTempo() {
  const codigo = buffer.trim();
  limparBuffer();
  // Sem Enter, so aceita codigos longos o bastante para nao confundir
  // com alguem digitando no teclado por engano.
  if (codigo.length >= MIN_SEM_ENTER) processarLeitura(codigo);
}

document.addEventListener('keydown', (e) => {
  // Atalho de ligar a leitura funciona sempre
  if (e.key === 'F2') { e.preventDefault(); ligar(); return; }

  if (e.key === 'Escape') {
    if (document.activeElement === ui.busca) ui.busca.blur();
    limparBuffer();
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    desfazer();
    return;
  }

  // A busca e a unica excecao: enquanto ela tem foco, a captura fica parada.
  if (digitandoEmCampo()) return;

  if (e.ctrlKey || e.altKey || e.metaKey) return;

  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    const codigo = buffer.trim();
    limparBuffer();
    if (codigo) processarLeitura(codigo);
    return;
  }

  if (e.key.length === 1) {
    e.preventDefault(); // evita busca-ao-digitar do navegador
    buffer += e.key;
    clearTimeout(cronometro);
    cronometro = setTimeout(fecharPorTempo, MS_FIM_LEITURA);
    atualizarDica('Lendo: ' + buffer + '…', true);
  }
});

/* ------------------------------------------------- fila de gravacao ---- */

// Escaneando rapido, varios POST sairiam em paralelo e poderiam ser gravados
// fora de ordem. Cada leitura espera a anterior terminar.
let fila = Promise.resolve();

function enfileirar(tarefa) {
  // O .catch mantém a fila viva mesmo se uma leitura falhar: a próxima roda.
  fila = fila.then(() => tarefa()).catch(() => {});
  return fila;
}

function processarLeitura(codigo) {
  if (!estado.ligado) {
    destravarAudio();
    som.erro();
    mostrarFaixa('faixa-erro', '⛔', 'CLIQUE EM ENTRADA PARA LIBERAR A LEITURA', codigo);
    return;
  }

  // Disparo duplo do leitor na mesma etiqueta: ignora sem alarme falso.
  const agora = Date.now();
  if (
    codigo === estado.ultimaLeitura.codigo &&
    agora - estado.ultimaLeitura.quando < MS_DUPLICATA
  ) {
    som.ignorada();
    mostrarFaixa('faixa-ignorada', '↻', 'LEITURA REPETIDA — IGNORADA', codigo);
    estado.ultimaLeitura.quando = agora;
    return;
  }
  estado.ultimaLeitura = { codigo, quando: agora };
  estado.ultimoScanEm = agora;

  enfileirar(() => enviarLeitura(codigo));
}

async function enviarLeitura(codigo) {
  let dados;
  try {
    const resposta = await fetch('/api/leitura', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codigo }),
    });
    dados = await resposta.json();
  } catch {
    som.erro();
    mostrarFaixa('faixa-erro', '\u{1F50C}', 'ERRO DE CONEXÃO — NÃO GRAVADO', codigo);
    return;
  }

  atualizarContadores(dados);

  if (!dados.ok) {
    som.erro();
    if (dados.erro === 'ja_guardado') {
      mostrarFaixa('faixa-erro', '⛔', 'JÁ ESTÁ GUARDADO', codigo);
    } else if (dados.erro === 'banco_fora_do_ar') {
      mostrarFaixa('faixa-erro', '\u{1F4F6}', 'SEM INTERNET — NÃO GRAVADO', codigo);
    } else {
      mostrarFaixa('faixa-erro', '⛔', 'NÃO GRAVADO', codigo + ' — ' + (dados.erro || 'erro'));
    }
    return;
  }

  estado.sessao += 1;
  ui.cSessao.textContent = String(estado.sessao);
  estado.ultimoId = dados.item.id;
  ui.btnDesfazer.disabled = false;

  som.entrada();
  mostrarFaixa('faixa-entrada', '✓', 'ENTRADA REGISTRADA', codigo);

  aplicarNaTabela(dados.item);
}

/* ------------------------------------------------------------ desfazer -- */

/** Motivo legível para a faixa de erro ao desfazer ou apagar. */
function explicarErro(erro, naoEncontrado) {
  if (erro === 'nao_encontrado') return naoEncontrado;
  if (erro === 'banco_fora_do_ar') return 'Sem internet — nada foi alterado';
  return erro;
}

async function desfazer() {
  const id = estado.ultimoId;
  if (id === null) return;

  ui.btnDesfazer.disabled = true;
  try {
    const resposta = await fetch('/api/desfazer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const dados = await resposta.json();
    atualizarContadores(dados);

    if (!dados.ok) {
      som.erro();
      const motivo = explicarErro(dados.erro, 'A entrada já não existe mais');
      mostrarFaixa('faixa-erro', '⛔', 'NÃO FOI POSSÍVEL DESFAZER', motivo);
      return;
    }

    estado.ultimoId = null;
    estado.ultimaLeitura = { codigo: null, quando: 0 };
    estado.sessao = Math.max(0, estado.sessao - 1);
    ui.cSessao.textContent = String(estado.sessao);
    bip(620, 0.07, 0.12);
    mostrarFaixa('faixa-ignorada', '↶', 'ENTRADA DESFEITA', dados.item.codigo);
    await carregarLista();
  } catch {
    som.erro();
    mostrarFaixa('faixa-erro', '\u{1F50C}', 'ERRO DE CONEXÃO AO DESFAZER', '');
    ui.btnDesfazer.disabled = false;
  }
}

/* -------------------------------------------------------------- apagar -- */

// Remoção avulsa pela lixeira da lista: serve para limpar um registro antigo,
// não só a última leitura. Pede confirmação porque não há como recuperar.
async function apagar(id, botao) {
  const linha = ui.corpo.querySelector('tr[data-id="' + id + '"]');
  const codigo = linha ? linha.querySelector('.celula-codigo').textContent : '';

  if (!confirm('Apagar o registro do código ' + codigo + '?\n\nIsso não pode ser desfeito.')) {
    return;
  }

  botao.disabled = true;
  let dados;
  try {
    const resposta = await fetch('/api/apagar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    dados = await resposta.json();
  } catch {
    som.erro();
    mostrarFaixa('faixa-erro', '\u{1F50C}', 'ERRO DE CONEXÃO AO APAGAR', codigo);
    botao.disabled = false;
    return;
  }

  atualizarContadores(dados);

  if (!dados.ok) {
    som.erro();
    const motivo = explicarErro(dados.erro, 'O registro já não existe mais');
    mostrarFaixa('faixa-erro', '⛔', 'NÃO FOI POSSÍVEL APAGAR', motivo);
    // Sumiu do banco por outro caminho: a lista na tela está velha.
    await carregarLista().catch(() => {});
    return;
  }

  // O desfazer aponta para um id que acabou de deixar de existir.
  if (estado.ultimoId === id) {
    estado.ultimoId = null;
    ui.btnDesfazer.disabled = true;
  }
  // Libera o código para ser bipado de novo em seguida sem cair na trava de
  // leitura repetida.
  if (estado.ultimaLeitura.codigo === codigo) {
    estado.ultimaLeitura = { codigo: null, quando: 0 };
  }

  bip(620, 0.07, 0.12);
  mostrarFaixa('faixa-ignorada', '\u{1F5D1}', 'REGISTRO APAGADO', dados.item.codigo);

  if (linha) linha.remove();
  // Com a lista cortada pelo limite, a linha apagada abre espaço para outra:
  // só uma recarga mostra a lista certa.
  if (estado.truncada) await carregarLista().catch(() => {});
  else atualizarVazio();
}

/* -------------------------------------------------------------- tabela -- */

const fmtData = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

const formatar = (iso) => (iso ? fmtData.format(new Date(iso)) : null);

function montarLinha(item) {
  const tr = document.createElement('tr');
  tr.dataset.id = String(item.id);

  const tdCodigo = document.createElement('td');
  tdCodigo.className = 'celula-codigo';
  tdCodigo.textContent = item.codigo;

  const tdEntrada = document.createElement('td');
  tdEntrada.className = 'celula-data preenchida';
  tdEntrada.textContent = formatar(item.entrada_em);

  const tdAcoes = document.createElement('td');
  tdAcoes.className = 'celula-acoes';

  const btnApagar = document.createElement('button');
  btnApagar.type = 'button';
  btnApagar.className = 'apagar';
  btnApagar.dataset.apagar = String(item.id);
  btnApagar.title = 'Apagar este registro';
  btnApagar.setAttribute('aria-label', 'Apagar o registro do código ' + item.codigo);
  btnApagar.textContent = '\u{1F5D1}';

  tdAcoes.append(btnApagar);
  tr.append(tdCodigo, tdEntrada, tdAcoes);
  return tr;
}

function pertenceAoFiltro(item) {
  if (estado.busca && !item.codigo.toLowerCase().includes(estado.busca.toLowerCase())) return false;
  return true;
}

// Atualizacao otimista: mexe so na linha afetada, sem recarregar a lista
// inteira a cada bipe.
function aplicarNaTabela(item) {
  const existente = ui.corpo.querySelector('tr[data-id="' + item.id + '"]');
  if (existente) existente.remove();

  if (pertenceAoFiltro(item)) {
    const tr = montarLinha(item);
    tr.classList.add('destacada');
    ui.corpo.prepend(tr);
  }
  atualizarVazio();
}

function atualizarContadores(dados) {
  if (typeof dados.guardados === 'number') ui.cGuardados.textContent = String(dados.guardados);
}

function atualizarVazio(info = null) {
  const temLinhas = ui.corpo.children.length > 0;
  ui.vazio.hidden = temLinhas;
  if (!temLinhas) {
    ui.vazio.textContent = estado.busca
      ? 'Nenhum código encontrado para “' + estado.busca + '”.'
      : 'Nada guardado no momento. Clique em ENTRADA e comece a escanear.';
  }
  if (info) estado.truncada = info.filtrados > info.itens.length;

  if (estado.truncada && info) {
    ui.rodape.textContent =
      'Mostrando ' + info.itens.length + ' de ' + info.filtrados +
      ' — refine a busca para ver o resto.';
  } else if (!estado.truncada) {
    // Sem truncagem, o que está na tela é a contagem real — vale também
    // depois de cada bipe, sem precisar recarregar a lista.
    const n = ui.corpo.children.length;
    ui.rodape.textContent = n ? n + (n === 1 ? ' registro.' : ' registros.') : '';
  }
}

async function carregarLista() {
  const params = new URLSearchParams({ q: estado.busca });
  const resposta = await fetch('/api/itens?' + params);
  const dados = await resposta.json();

  ui.corpo.replaceChildren(...dados.itens.map(montarLinha));
  atualizarContadores(dados);
  atualizarVazio(dados);
}

/* ------------------------------------------------------------ eventos --- */

ui.btnEntrada.addEventListener('click', ligar);
ui.btnDesfazer.addEventListener('click', desfazer);

// Delegação: as linhas são recriadas a cada carga da lista.
ui.corpo.addEventListener('click', (e) => {
  const botao = e.target.closest('button[data-apagar]');
  if (botao) apagar(Number(botao.dataset.apagar), botao);
});

let cronoBusca = null;
ui.busca.addEventListener('input', () => {
  clearTimeout(cronoBusca);
  cronoBusca = setTimeout(() => {
    estado.busca = ui.busca.value.trim();
    carregarLista();
  }, 250);
});

ui.busca.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); ui.busca.blur(); }
});
ui.busca.addEventListener('focus', () => atualizarDica());
ui.busca.addEventListener('blur', () => atualizarDica());

// Qualquer clique destrava o audio e devolve a leitura ao documento.
document.addEventListener('click', (e) => {
  destravarAudio();
  if (e.target !== ui.busca && document.activeElement === ui.busca) ui.busca.blur();
});

// Outro dispositivo pode estar escaneando: atualiza quando esta tela esta parada.
setInterval(() => {
  if (document.hidden) return;
  if (document.activeElement === ui.busca) return;
  if (Date.now() - estado.ultimoScanEm < 5000) return;
  carregarLista().catch(() => {});
}, MS_POLL);

window.addEventListener('focus', () => {
  if (Date.now() - estado.ultimoScanEm > 3000) carregarLista().catch(() => {});
});

carregarLista().catch(() => {
  mostrarFaixa('faixa-erro', '\u{1F50C}', 'SEM CONEXÃO COM O SERVIDOR', 'O painel foi desligado?');
});
atualizarDica();
