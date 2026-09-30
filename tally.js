'use strict';

/* ==========================================================================
   Leitura das respostas do formulario do Tally que os entregadores preenchem.

   A chave da API fica so no servidor (variavel TALLY_API_KEY ou tally.json;
   na Vercel, so a variavel); o navegador nunca a ve. Devolve cada envio ja
   com os codigos separados,
   porque no formulario eles vem num campo de texto livre, um por linha.
   ========================================================================== */

const fs = require('node:fs');
const path = require('node:path');

const banco = require('./db');

const CAMINHO_CONFIG = path.join(__dirname, 'tally.json');
const API = 'https://api.tally.so';
const FORMULARIO_PADRAO = ''; // defina TALLY_FORM_ID ou formId no tally.json

// Perguntas achadas pelo rotulo, para continuar funcionando se o formulario
// for editado. Os ids sao o plano B, caso o rotulo mude.
const PERGUNTAS = {
  codigos:        { re: /codigo/,           id: 'Q_CODIGOS' },
  quantidade:     { re: /quantidade/i,      id: 'Q_QUANTIDADE' },
  transportadora: { re: /transportadora/i,  id: 'Q_TRANSPORTADORA' },
  cidade:         { re: /cidade/i,          id: 'Q_CIDADE' },
  tipo:           { re: /relatar/i,         id: 'Q_TIPO' },
  observacoes:    { re: /observa/i,         id: 'Q_OBSERVACOES' },
};

class ErroTally extends Error {
  constructor(codigo, mensagem) {
    super(mensagem);
    this.codigo = codigo;
  }
}

function lerConfig() {
  let arquivo = {};
  try {
    arquivo = JSON.parse(fs.readFileSync(CAMINHO_CONFIG, 'utf8'));
  } catch { /* sem arquivo ainda: tudo bem */ }

  return {
    chave: process.env.TALLY_API_KEY || arquivo.chave || '',
    formId: process.env.TALLY_FORM_ID || arquivo.formId || FORMULARIO_PADRAO,
  };
}

function salvarChave(chave) {
  const atual = lerConfig();
  const conteudo = { chave: String(chave).trim(), formId: atual.formId };
  fs.writeFileSync(CAMINHO_CONFIG, JSON.stringify(conteudo, null, 2));
}

const temChave = () => Boolean(lerConfig().chave);

/* --------------------------------------------------------------------------
   Confirmacoes: quando o entregador digitou o codigo com erro e o operador
   confirma que ele e, na verdade, um codigo parecido do estoque. Devolve
   { chaveDigitada: { codigo, confirmado_em } }, com as chaves ja normalizadas
   pelo navegador (mesma normalizacao usada no cruzamento). Fica na tabela
   tally_confirmacoes, para a consulta na nuvem enxergar o mesmo.
   -------------------------------------------------------------------------- */

const ISO = (coluna) =>
  `to_char(${coluna} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ${coluna}`;

async function lerConfirmacoes() {
  const linhas = await banco.consultar(
    `SELECT digitado, codigo, ${ISO('confirmado_em')} FROM tally_confirmacoes`
  );
  return Object.fromEntries(
    linhas.map(({ digitado, codigo, confirmado_em }) => [digitado, { codigo, confirmado_em }])
  );
}

async function confirmar(digitado, codigo) {
  await banco.consultar(
    `INSERT INTO tally_confirmacoes (digitado, codigo, confirmado_em) VALUES ($1, $2, now())
     ON CONFLICT (digitado) DO UPDATE SET codigo = EXCLUDED.codigo, confirmado_em = EXCLUDED.confirmado_em`,
    [digitado, codigo]
  );
}

async function desfazerConfirmacao(digitado) {
  await banco.consultar('DELETE FROM tally_confirmacoes WHERE digitado = $1', [digitado]);
}

/* --------------------------------------------------------------------------
   Resolvidos: codigos que ficaram como "nao recebido" e nao casam com nenhuma
   bipagem, mas ja foram tratados fora do sistema. Devolve
   { chaveDigitada: { observacao, resolvido_em } }. A observacao e obrigatoria
   e conta o que aconteceu com o volume. Fica na tabela tally_resolvidos.
   -------------------------------------------------------------------------- */

async function lerResolvidos() {
  const linhas = await banco.consultar(
    `SELECT digitado, observacao, ${ISO('resolvido_em')} FROM tally_resolvidos`
  );
  return Object.fromEntries(
    linhas.map(({ digitado, observacao, resolvido_em }) => [digitado, { observacao, resolvido_em }])
  );
}

async function resolver(digitado, observacao) {
  await banco.consultar(
    `INSERT INTO tally_resolvidos (digitado, observacao, resolvido_em) VALUES ($1, $2, now())
     ON CONFLICT (digitado) DO UPDATE SET observacao = EXCLUDED.observacao, resolvido_em = EXCLUDED.resolvido_em`,
    [digitado, observacao]
  );
}

async function desfazerResolucao(digitado) {
  await banco.consultar('DELETE FROM tally_resolvidos WHERE digitado = $1', [digitado]);
}

/** Resposta do Tally em texto: escolha multipla vem como lista. */
function comoTexto(resposta) {
  if (resposta === null || resposta === undefined) return '';
  if (Array.isArray(resposta)) return resposta.map(comoTexto).filter(Boolean).join(', ');
  if (typeof resposta === 'object') return String(resposta.name ?? resposta.text ?? '');
  return String(resposta).trim();
}

/** Rotulo sem acento e em minusculas: "Códigos dos Produtos" -> "codigos dos produtos". */
const simplificar = (texto) =>
  String(texto ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

function mapearPerguntas(perguntas) {
  const rotulo = (p) => simplificar(p.title ?? p.label);
  const mapa = {};
  for (const [campo, { re, id }] of Object.entries(PERGUNTAS)) {
    const porRotulo = perguntas.find((p) => re.test(rotulo(p)));
    mapa[campo] = porRotulo ? porRotulo.id : id;
  }
  // "Você deseja informar o código do produto?" (escolha multipla) tambem
  // casa com /codigo/. A certa e "Códigos dos produtos", que e texto livre.
  const ehTexto = (p) => /TEXT|INPUT_TEXT/.test(p.type || '');
  const codigos =
    perguntas.find((p) => rotulo(p) === 'codigos dos produtos') ||
    perguntas.find((p) => ehTexto(p) && PERGUNTAS.codigos.re.test(rotulo(p)));
  mapa.codigos = codigos ? codigos.id : PERGUNTAS.codigos.id;
  return mapa;
}

/**
 * Separa os varios codigos digitados a mao no mesmo campo. Aceita quebra de
 * linha, espaco, virgula, ponto e virgula, barra, "|" e "+", descola codigos
 * grudados depois do sufixo "tx" (ex: "ABCD123456tx EFGH456789tx" sem espaco) e
 * tira numeracao de lista ("1-", "2)") e pontuacao solta nas pontas.
 *
 * Joga fora os pedacos sem nenhum algarismo: todo codigo de produto tem
 * numero, entao o que sobrou e palavra que o entregador escreveu junto
 * ("Abcd230726110tx ( caixa)" e um codigo so, nao dois).
 */
function separarCodigos(texto) {
  return String(texto ?? '')
    .replace(/(tx)(?=[a-z]{3,5}\d{6,})/gi, '$1\n')
    .split(/[\s,;/|+]+/)
    .map((c) => c.replace(/^\d{1,2}[).:-]+(?=\S)/, '').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((c) => c.length >= 3 && /\d/.test(c));
}

async function pedir(url, chave) {
  let resposta;
  try {
    resposta = await fetch(url, { headers: { Authorization: `Bearer ${chave}` } });
  } catch {
    throw new ErroTally('tally_fora_do_ar', 'Não consegui falar com o Tally. A internet está ok?');
  }

  if (resposta.status === 401 || resposta.status === 403) {
    throw new ErroTally('chave_invalida', 'A chave do Tally foi recusada. Cole uma chave nova.');
  }
  if (resposta.status === 404) {
    throw new ErroTally('formulario_nao_encontrado', 'O formulário do Tally não foi encontrado.');
  }
  if (resposta.status === 429) {
    throw new ErroTally('tally_limite', 'O Tally pediu para esperar um pouco. Tente em 1 minuto.');
  }
  if (!resposta.ok) {
    throw new ErroTally('tally_fora_do_ar', `O Tally respondeu com erro ${resposta.status}.`);
  }
  return resposta.json();
}

/** ISO sem milissegundos, formato que a API aceita sem reclamar. */
const isoSemMs = (iso) => new Date(iso).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Todos os envios completos entre `inicio` e `fim` (ISO), ja paginados.
 */
async function buscarSubmissoes(inicio, fim) {
  const { chave, formId } = lerConfig();
  if (!chave) throw new ErroTally('sem_chave', 'Falta a chave da API do Tally.');

  const envios = [];
  let perguntas = [];

  for (let pagina = 1; pagina <= 50; pagina++) {
    const params = new URLSearchParams({
      page: String(pagina),
      limit: '500',
      filter: 'completed',
      startDate: isoSemMs(inicio),
      endDate: isoSemMs(fim),
    });
    const dados = await pedir(`${API}/forms/${formId}/submissions?${params}`, chave);

    if (dados.questions?.length) perguntas = dados.questions;
    const mapa = mapearPerguntas(perguntas);

    for (const s of dados.submissions || []) {
      if (s.isCompleted === false) continue;

      const valor = (campo) =>
        (s.responses || []).find((r) => r.questionId === mapa[campo])?.answer;

      const quantidade = Number(valor('quantidade'));
      envios.push({
        id: s.id,
        enviado_em: s.submittedAt,
        tipo: comoTexto(valor('tipo')),
        transportadora: comoTexto(valor('transportadora')),
        cidade: comoTexto(valor('cidade')),
        quantidade: Number.isFinite(quantidade) ? quantidade : null,
        observacoes: comoTexto(valor('observacoes')),
        codigos: separarCodigos(valor('codigos')),
      });
    }

    if (!dados.hasMore) break;
  }

  // O filtro de data do Tally e a referencia, mas conferimos aqui tambem.
  const ini = new Date(inicio).getTime();
  const fi = new Date(fim).getTime();
  return envios.filter((e) => {
    const t = new Date(e.enviado_em).getTime();
    return t >= ini && t < fi;
  });
}

module.exports = {
  buscarSubmissoes, separarCodigos, salvarChave, temChave, ErroTally, CAMINHO_CONFIG,
  lerConfirmacoes, confirmar, desfazerConfirmacao,
  lerResolvidos, resolver, desfazerResolucao,
};
