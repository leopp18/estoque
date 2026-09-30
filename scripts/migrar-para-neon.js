'use strict';

/* ==========================================================================
   Copia os dados antigos deste PC para o Neon, uma vez:
     estoque.db               -> tabela itens (com os mesmos ids)
     tally-confirmados.json   -> tabela tally_confirmacoes
     tally-resolvidos.json    -> tabela tally_resolvidos

   Pode rodar de novo sem duplicar nada: o que já existe no Neon fica como
   está. Os arquivos antigos não são alterados e servem de backup.

   Uso:  node scripts/migrar-para-neon.js
   ========================================================================== */

process.removeAllListeners('warning'); // node:sqlite ainda é "experimental"

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const banco = require('../db');

const RAIZ = path.join(__dirname, '..');
const LOTE = 200;

function lerJson(nome) {
  try {
    return JSON.parse(fs.readFileSync(path.join(RAIZ, nome), 'utf8'));
  } catch {
    return {};
  }
}

/** INSERT de várias linhas de uma vez: ($1,$2,$3),($4,$5,$6)… */
async function inserirEmLotes(tabela, colunas, linhas, conflito) {
  let inseridas = 0;
  for (let i = 0; i < linhas.length; i += LOTE) {
    const lote = linhas.slice(i, i + LOTE);
    const valores = lote
      .map((_, l) => '(' + colunas.map((_, c) => '$' + (l * colunas.length + c + 1)).join(', ') + ')')
      .join(', ');
    const r = await banco.consultar(
      `INSERT INTO ${tabela} (${colunas.join(', ')}) VALUES ${valores}
       ON CONFLICT ${conflito} DO NOTHING RETURNING 1`,
      lote.flat()
    );
    inseridas += r.length;
  }
  return inseridas;
}

async function main() {
  await banco.garantirEsquema();

  const sqlite = new DatabaseSync(path.join(RAIZ, 'estoque.db'), { readOnly: true });
  const itens = sqlite.prepare('SELECT id, codigo, entrada_em FROM itens ORDER BY id').all();
  sqlite.close();

  // ON CONFLICT sem alvo cobre tanto id quanto código já existentes.
  const nItens = await inserirEmLotes(
    'itens', ['id', 'codigo', 'entrada_em'],
    itens.map((i) => [i.id, i.codigo, i.entrada_em]), ''
  );
  // Os ids vieram prontos: a próxima bipagem precisa continuar depois do maior.
  await banco.consultar(
    `SELECT setval(pg_get_serial_sequence('itens', 'id'), GREATEST((SELECT MAX(id) FROM itens), 1))`
  );

  const confirmacoes = Object.entries(lerJson('tally-confirmados.json'));
  const nConf = await inserirEmLotes(
    'tally_confirmacoes', ['digitado', 'codigo', 'confirmado_em'],
    confirmacoes.map(([d, v]) => [d, v.codigo, v.confirmado_em]), '(digitado)'
  );

  const resolvidos = Object.entries(lerJson('tally-resolvidos.json'));
  const nRes = await inserirEmLotes(
    'tally_resolvidos', ['digitado', 'observacao', 'resolvido_em'],
    resolvidos.map(([d, v]) => [d, v.observacao, v.resolvido_em]), '(digitado)'
  );

  const [{ total }] = await banco.consultar('SELECT COUNT(*)::int AS total FROM itens');

  console.log('');
  console.log(`  Itens:         ${nItens} copiados de ${itens.length} (Neon tem ${total})`);
  console.log(`  Confirmações:  ${nConf} copiadas de ${confirmacoes.length}`);
  console.log(`  Resolvidos:    ${nRes} copiados de ${resolvidos.length}`);
  console.log('');
}

main().catch((e) => {
  console.error('\n  A migração falhou:', e.message, '\n');
  process.exit(1);
});
