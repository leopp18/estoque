'use strict';

/* ==========================================================================
   Build da Vercel: monta a pasta site/ só com a página de consulta. O painel
   de bipagem, a conferência do PBI e a tela do Tally com edição ficam de fora
   — não existem na internet, nem como arquivo estático.
   ========================================================================== */

const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const PUBLICO = path.join(RAIZ, 'public');
const SAIDA = path.join(RAIZ, 'site');

// destino em site/  <-  origem em public/
const ARQUIVOS = {
  'index.html': 'consulta.html',
  'tally.js': 'tally.js',
  'normalizar.js': 'normalizar.js',
  'style.css': 'style.css',
};

fs.rmSync(SAIDA, { recursive: true, force: true });
fs.mkdirSync(SAIDA);

for (const [destino, origem] of Object.entries(ARQUIVOS)) {
  fs.copyFileSync(path.join(PUBLICO, origem), path.join(SAIDA, destino));
}

// Página interna: nenhum buscador deve indexar.
fs.writeFileSync(path.join(SAIDA, 'robots.txt'), 'User-agent: *\nDisallow: /\n');

console.log(`site/ montado: ${Object.keys(ARQUIVOS).join(', ')}, robots.txt`);
