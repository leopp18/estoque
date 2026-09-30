'use strict';

/* ==========================================================================
   Normalização de códigos, compartilhada pelas telas de conferência.
   ========================================================================== */

const RE_CIENTIFICA = /^[+-]?\d+(?:[.,]\d+)?E[+-]?\d+$/i;

/**
 * Deixa os dois lados comparáveis. O Excel transforma códigos longos em
 * notação científica sozinho, e sem desfazer isso o cruzamento não acha nada.
 */
function normalizarCodigo(bruto, ignorarZeros = false) {
  let s = String(bruto ?? '').replace(/[\s\u00a0\u200b-\u200d\ufeff]/g, '');
  if (!s) return '';
  s = s.toUpperCase();

  if (RE_CIENTIFICA.test(s)) {
    const n = Number(s.replace(',', '.'));
    if (Number.isFinite(n)) s = n.toFixed(0);
  }

  s = s.replace(/[.,]0+$/, '');            // 123456,0 -> 123456
  if (ignorarZeros) s = s.replace(/^0+(?=.)/, '');
  return s;
}

const ehCientifica = (bruto) =>
  RE_CIENTIFICA.test(String(bruto ?? '').replace(/[\s\u00a0]/g, ''));
