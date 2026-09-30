'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const banco = require('./db');
const planilha = require('./planilha');
const tally = require('./tally');
const { montarConferencia } = require('./conferencia');

const PORTA = Number(process.env.PORTA || process.env.PORT || 3030);
// Porta só de leitura, a que pode ir para a internet: serve apenas a página
// de consulta da conferência Tally e a busca dos dados dela.
const PORTA_CONSULTA = Number(process.env.PORTA_CONSULTA || 3051);
const MAX_DIAS_CONSULTA = 93;
const LIMITE_PLANILHA = 40 * 1024 * 1024; // planilha do PBI pode ser grande
const MAX_OBSERVACAO = 200; // observação da resolução: um recado curto
const PUBLICO = path.join(__dirname, 'public');

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function json(res, status, corpo) {
  const dados = JSON.stringify(corpo);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(dados),
    'Cache-Control': 'no-store',
  });
  res.end(dados);
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let bruto = '';
    req.on('data', (pedaco) => {
      bruto += pedaco;
      if (bruto.length > 1e6) {
        reject(new Error('corpo_grande_demais'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!bruto) return resolve({});
      try {
        resolve(JSON.parse(bruto));
      } catch {
        reject(new Error('json_invalido'));
      }
    });
    req.on('error', reject);
  });
}

/** Corpo binário (arquivo de planilha), com limite próprio bem maior. */
function lerBytes(req, limite) {
  return new Promise((resolve, reject) => {
    const pedacos = [];
    let tamanho = 0;
    req.on('data', (pedaco) => {
      tamanho += pedaco.length;
      if (tamanho > limite) {
        reject(new Error('arquivo_grande_demais'));
        req.destroy();
        return;
      }
      pedacos.push(pedaco);
    });
    req.on('end', () => resolve(Buffer.concat(pedacos)));
    req.on('error', reject);
  });
}

function servirEstatico(req, res, urlPath) {
  const relativo = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const destino = path.resolve(PUBLICO, relativo);

  // Impede sair da pasta public via ../
  if (destino !== PUBLICO && !destino.startsWith(PUBLICO + path.sep)) {
    res.writeHead(403).end('Proibido');
    return;
  }

  fs.readFile(destino, (erro, conteudo) => {
    if (erro) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Não encontrado');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TIPOS[path.extname(destino).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(conteudo);
  });
}

async function responderConferencia(res, url, maxDias) {
  const { status, corpo } = await montarConferencia(url, maxDias);
  return json(res, status, corpo);
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const rota = url.pathname;

  try {
    if (rota === '/api/itens' && req.method === 'GET') {
      const limite = Math.min(Number(url.searchParams.get('limite')) || 500, 2000);
      const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
      const q = url.searchParams.get('q') || '';
      return json(res, 200, await banco.listar({ q, limite, offset }));
    }

    if (rota === '/api/leitura' && req.method === 'POST') {
      const corpo = await lerCorpo(req);
      const codigo = String(corpo.codigo ?? '').trim();

      if (!codigo) return json(res, 400, { ok: false, erro: 'codigo_vazio' });

      const resultado = await banco.registrarEntrada(codigo);
      return json(res, 200, { ...resultado, ...(await banco.contadores()) });
    }

    // Desfazer a última leitura e apagar um registro escolhido na lista são a
    // mesma operação no banco; ficam em rotas separadas só porque a tela trata
    // os dois casos de formas diferentes.
    if ((rota === '/api/desfazer' || rota === '/api/apagar') && req.method === 'POST') {
      const corpo = await lerCorpo(req);
      const id = Number(corpo.id);
      if (!Number.isInteger(id)) return json(res, 400, { ok: false, erro: 'id_invalido' });

      const resultado = await banco.removerPorId(id);
      return json(res, 200, { ...resultado, ...(await banco.contadores()) });
    }

    if (rota === '/api/codigos' && req.method === 'GET') {
      return json(res, 200, { ok: true, codigos: await banco.todosOsCodigos() });
    }

    // Recebe os bytes crus do arquivo (ou o texto colado do Excel) e devolve
    // a planilha já interpretada. O cruzamento em si acontece no navegador.
    if (rota === '/api/planilha' && req.method === 'POST') {
      const bytes = await lerBytes(req, LIMITE_PLANILHA);
      if (!bytes.length) return json(res, 400, { ok: false, erro: 'arquivo_vazio' });

      const nome = decodeURIComponent(req.headers['x-nome-arquivo'] || '');
      const aba = decodeURIComponent(req.headers['x-aba'] || '') || null;

      try {
        const tabela = planilha.ler(bytes, nome, aba);
        return json(res, 200, { ok: true, nome, ...tabela });
      } catch (e) {
        // Erro de formato é problema do arquivo, não do servidor: mensagem
        // legível na tela em vez de stack trace.
        return json(res, 200, { ok: false, erro: 'planilha_invalida', mensagem: e.message });
      }
    }

    if (rota === '/api/tally/conferencia' && req.method === 'GET') {
      return await responderConferencia(res, url);
    }

    if (rota === '/api/tally/chave' && req.method === 'POST') {
      const corpo = await lerCorpo(req);
      const chave = String(corpo.chave ?? '').trim();
      if (!chave) return json(res, 400, { ok: false, erro: 'chave_vazia' });
      tally.salvarChave(chave);
      return json(res, 200, { ok: true });
    }

    // Operador confirma que um código digitado errado no formulário é, na
    // verdade, outro código do estoque. `codigo` vazio desfaz a confirmação.
    if (rota === '/api/tally/confirmar' && req.method === 'POST') {
      const corpo = await lerCorpo(req);
      const digitado = String(corpo.digitado ?? '').trim();
      const codigo = String(corpo.codigo ?? '').trim();
      if (!digitado) return json(res, 400, { ok: false, erro: 'codigo_vazio' });
      if (codigo) await tally.confirmar(digitado, codigo);
      else await tally.desfazerConfirmacao(digitado);
      return json(res, 200, { ok: true, confirmacoes: await tally.lerConfirmacoes() });
    }

    // Operador marca um "nao recebido" como resolvido fora do sistema, com uma
    // observacao curta contando o que aconteceu. Observacao vazia desfaz.
    if (rota === '/api/tally/resolver' && req.method === 'POST') {
      const corpo = await lerCorpo(req);
      const digitado = String(corpo.digitado ?? '').trim();
      const observacao = String(corpo.observacao ?? '').trim().slice(0, MAX_OBSERVACAO);
      if (!digitado) return json(res, 400, { ok: false, erro: 'codigo_vazio' });
      if (observacao) await tally.resolver(digitado, observacao);
      else await tally.desfazerResolucao(digitado);
      return json(res, 200, { ok: true, resolvidos: await tally.lerResolvidos() });
    }

    if (rota === '/api/tally/status' && req.method === 'GET') {
      return json(res, 200, { ok: true, temChave: tally.temChave() });
    }

    if (rota.startsWith('/api/')) {
      return json(res, 404, { ok: false, erro: 'rota_desconhecida' });
    }

    return servirEstatico(req, res, rota);
  } catch (e) {
    if (
      e.message === 'json_invalido' ||
      e.message === 'corpo_grande_demais' ||
      e.message === 'arquivo_grande_demais'
    ) {
      return json(res, 400, { ok: false, erro: e.message });
    }
    // Sem internet: a tela avisa e nada foi gravado.
    if (e instanceof banco.ErroBanco) {
      console.error('[banco]', e.cause?.message || e.message);
      return json(res, 503, { ok: false, erro: e.codigo });
    }
    console.error('[erro]', e);
    return json(res, 500, { ok: false, erro: 'erro_interno', detalhe: String(e.message) });
  }
});

// Tudo o que a porta de consulta aceita. Qualquer outra coisa (gravar, apagar,
// trocar a chave do Tally, as outras telas) responde 404.
const ARQUIVOS_CONSULTA = {
  '/': '/consulta.html',
  '/consulta.html': '/consulta.html',
  '/tally.js': '/tally.js',
  '/normalizar.js': '/normalizar.js',
  '/style.css': '/style.css',
};

const servidorConsulta = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const rota = url.pathname;

  // Página interna: nenhum buscador deve indexar nem arquivar isto.
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');

  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { ok: false, erro: 'somente_leitura' });
    }
    if (rota === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(['User-agent: *', 'Disallow: /', ''].join(String.fromCharCode(10)));
    }
    if (rota === '/api/tally/conferencia') {
      return await responderConferencia(res, url, MAX_DIAS_CONSULTA);
    }
    if (ARQUIVOS_CONSULTA[rota]) {
      return servirEstatico(req, res, ARQUIVOS_CONSULTA[rota]);
    }
    if (rota.startsWith('/api/')) {
      return json(res, 404, { ok: false, erro: 'rota_desconhecida' });
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Não encontrado');
  } catch (e) {
    if (e instanceof banco.ErroBanco) return json(res, 503, { ok: false, erro: e.codigo });
    console.error('[erro consulta]', e);
    return json(res, 500, { ok: false, erro: 'erro_interno' });
  }
});

function ipsDaRede() {
  const enderecos = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const i of interfaces || []) {
      if (i.family === 'IPv4' && !i.internal) enderecos.push(i.address);
    }
  }
  return enderecos;
}

function ligar() {
  servidor.listen(PORTA, '0.0.0.0', () => {
    console.log('');
    console.log('  PAINEL DE ESTOQUE no ar');
    console.log('  ------------------------------------------');
    console.log(`  Neste computador:  http://localhost:${PORTA}`);
    for (const ip of ipsDaRede()) {
      console.log(`  Na rede local:     http://${ip}:${PORTA}`);
    }
    console.log(`  Consulta (leitura): http://localhost:${PORTA_CONSULTA}`);
    console.log('  Banco de dados:    Neon (nuvem)');
    console.log('  ------------------------------------------');
    console.log('  Feche esta janela para desligar o painel.');
    console.log('');

    // Abre o navegador só quando iniciado pelo iniciar.bat, e só depois que o
    // servidor já está aceitando conexões (evita a tela de "não conectou").
    if (process.env.ABRIR_NAVEGADOR === '1' && process.platform === 'win32') {
      require('node:child_process').spawn(
        'cmd',
        ['/c', 'start', '', `http://localhost:${PORTA}`],
        { detached: true, stdio: 'ignore' }
      ).unref();
    }
  });
}

servidor.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  A porta ${PORTA} já está em uso.`);
    console.error('  O painel já pode estar aberto em outra janela.\n');
    process.exit(1);
  }
  throw e;
});

servidorConsulta.on('error', (e) => {
  // Sem a consulta o painel principal continua funcionando normalmente.
  if (e.code === 'EADDRINUSE') {
    console.error(`
  A porta ${PORTA_CONSULTA} (consulta) já está em uso; a página de consulta não subiu.
`);
    return;
  }
  throw e;
});

// A porta abre na hora (o iniciar.bat espera por ela) e o esquema é criado
// em paralelo, se faltar. Sem internet ao ligar, tenta de novo a cada 15 s:
// a tarefa agendada sobe o painel no logon, às vezes antes do Wi-Fi.
async function garantirEsquema() {
  try {
    await banco.garantirEsquema();
  } catch (e) {
    console.error('  Sem conexão com o banco na nuvem. Tentando de novo em 15 s...');
    if (!(e instanceof banco.ErroBanco)) console.error(e);
    setTimeout(garantirEsquema, 15000);
  }
}

ligar();
servidorConsulta.listen(PORTA_CONSULTA, '0.0.0.0');
garantirEsquema();
