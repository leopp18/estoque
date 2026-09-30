'use strict';

/* ==========================================================================
   Função da Vercel: a única rota da consulta publicada. Só lê — o mesmo que
   a porta 3051 do servidor deste PC entrega em /api/tally/conferencia.
   ========================================================================== */

const { montarConferencia } = require('../../conferencia');

const MAX_DIAS_CONSULTA = 93;

function json(res, status, corpo) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
  });
  res.end(JSON.stringify(corpo));
}

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json(res, 405, { ok: false, erro: 'somente_leitura' });
  }
  try {
    const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
    const { status, corpo } = await montarConferencia(url, MAX_DIAS_CONSULTA);
    return json(res, status, corpo);
  } catch (e) {
    console.error('[erro consulta]', e);
    return json(res, 500, { ok: false, erro: 'erro_interno' });
  }
};
