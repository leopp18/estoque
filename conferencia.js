'use strict';

/* ==========================================================================
   Conferência com os formulários do Tally: junta os envios do Tally com o que
   foi bipado. Usada pelo servidor deste PC (as duas portas) e pela função da
   Vercel, que é a página de consulta publicada.
   ========================================================================== */

const banco = require('./db');
const tally = require('./tally');

const FOLGA_TALLY_DIAS = 3;

/**
 * Os envios são buscados com alguns dias de folga para trás: o entregador
 * costuma preencher antes de chegar, e um volume bipado hoje não deve acusar
 * "sem formulário" só porque o formulário foi enviado ontem à noite.
 *
 * Devolve { status, corpo } para quem chamou escrever a resposta HTTP.
 */
async function montarConferencia(url, maxDias = Infinity) {
  const inicio = new Date(url.searchParams.get('inicio') || '');
  const fim = new Date(url.searchParams.get('fim') || '');
  if (Number.isNaN(inicio.getTime()) || Number.isNaN(fim.getTime()) || fim <= inicio) {
    return { status: 400, corpo: { ok: false, erro: 'periodo_invalido' } };
  }
  if ((fim - inicio) / 86400000 > maxDias) {
    return {
      status: 200,
      corpo: { ok: false, erro: 'periodo_longo', mensagem: `Escolha um período de até ${maxDias} dias.` },
    };
  }

  const folga = new Date(inicio.getTime() - FOLGA_TALLY_DIAS * 86400000);

  try {
    const [envios, bipados, estoque, confirmacoes, resolvidos] = await Promise.all([
      tally.buscarSubmissoes(folga.toISOString(), fim.toISOString()),
      banco.entradasNoPeriodo(inicio.toISOString(), fim.toISOString()),
      banco.todosOsCodigos(),
      tally.lerConfirmacoes(),
      tally.lerResolvidos(),
    ]);
    return {
      status: 200,
      corpo: {
        ok: true,
        inicio: inicio.toISOString(),
        fim: fim.toISOString(),
        submissoes: envios.map((e) => ({ ...e, no_periodo: new Date(e.enviado_em) >= inicio })),
        bipados,
        estoque,
        confirmacoes,
        resolvidos,
      },
    };
  } catch (e) {
    if (e instanceof tally.ErroTally) {
      return { status: 200, corpo: { ok: false, erro: e.codigo, mensagem: e.message } };
    }
    if (e instanceof banco.ErroBanco) {
      return {
        status: 503,
        corpo: { ok: false, erro: e.codigo, mensagem: 'Não consegui falar com o banco de dados. Tente de novo em instantes.' },
      };
    }
    throw e;
  }
}

module.exports = { montarConferencia };
