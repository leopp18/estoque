'use strict';

/* ==========================================================================
   Leitura de planilhas sem nenhuma dependencia externa.

   Dois formatos:
     - texto delimitado (CSV / TSV), inclusive o que sai do Excel pt-BR
     - .xlsx, que e um ZIP de arquivos XML e e descompactado aqui na mao

   Ambos devolvem o mesmo formato:
     { colunas: [...], linhas: [[...], ...], abas: [...], aba: 'nome' }
   ========================================================================== */

const zlib = require('node:zlib');

/* ======================================================== texto (CSV/TSV) == */

/**
 * Decodifica os bytes em texto. Exportacao brasileira vem em Latin-1 com
 * frequencia; se o UTF-8 produzir caracteres invalidos, relemos como Latin-1.
 */
function decodificar(buffer) {
  let texto = buffer.toString('utf8');
  if (texto.includes('�')) {
    texto = buffer.toString('latin1');
  }
  // Remove o BOM que o Excel costuma colocar no inicio.
  if (texto.charCodeAt(0) === 0xfeff) texto = texto.slice(1);
  return texto;
}

/**
 * Descobre o separador contando ocorrencias fora de aspas na primeira linha.
 * Excel e Power BI em pt-BR usam ';' com muita frequencia.
 */
function detectarSeparador(texto) {
  const primeiraLinha = texto.split(/\r?\n/, 1)[0] || '';
  let dentroDeAspas = false;
  const contagem = { ';': 0, ',': 0, '\t': 0, '|': 0 };

  for (const ch of primeiraLinha) {
    if (ch === '"') dentroDeAspas = !dentroDeAspas;
    else if (!dentroDeAspas && ch in contagem) contagem[ch]++;
  }

  let melhor = ';';
  for (const sep of Object.keys(contagem)) {
    if (contagem[sep] > contagem[melhor]) melhor = sep;
  }
  return contagem[melhor] > 0 ? melhor : ';';
}

/**
 * Parser RFC4180: aspas, aspas escapadas ("") e quebra de linha dentro do
 * campo. A tratativa pode conter virgula, entao isso nao e opcional.
 */
function separarLinhas(texto, sep) {
  const linhas = [];
  let campo = '';
  let linha = [];
  let dentroDeAspas = false;

  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];

    if (dentroDeAspas) {
      if (ch === '"') {
        if (texto[i + 1] === '"') { campo += '"'; i++; }
        else dentroDeAspas = false;
      } else {
        campo += ch;
      }
      continue;
    }

    if (ch === '"') { dentroDeAspas = true; continue; }
    if (ch === sep) { linha.push(campo); campo = ''; continue; }

    if (ch === '\r') continue;
    if (ch === '\n') {
      linha.push(campo);
      linhas.push(linha);
      linha = [];
      campo = '';
      continue;
    }
    campo += ch;
  }

  if (campo !== '' || linha.length) {
    linha.push(campo);
    linhas.push(linha);
  }
  return linhas;
}

function lerTexto(entrada) {
  const texto = Buffer.isBuffer(entrada) ? decodificar(entrada) : String(entrada);
  const sep = detectarSeparador(texto);
  const linhas = separarLinhas(texto, sep).filter(
    (l) => l.some((c) => String(c).trim() !== '')
  );

  if (!linhas.length) {
    throw new Error('A planilha esta vazia.');
  }

  const colunas = nomearColunas(linhas[0].map((c) => String(c).trim()));
  const dados = linhas.slice(1).map((l) => {
    const linha = new Array(colunas.length).fill('');
    for (let i = 0; i < colunas.length; i++) linha[i] = (l[i] ?? '').trim();
    return linha;
  });

  return { colunas, linhas: dados, abas: [], aba: null, separador: sep };
}

/** Cabecalho vazio ou repetido vira um nome utilizavel. */
function nomearColunas(brutas) {
  const vistas = new Map();
  return brutas.map((nome, i) => {
    let limpo = nome || `Coluna ${i + 1}`;
    if (vistas.has(limpo)) {
      const n = vistas.get(limpo) + 1;
      vistas.set(limpo, n);
      limpo = `${limpo} (${n})`;
    } else {
      vistas.set(limpo, 1);
    }
    return limpo;
  });
}

/* ================================================================== ZIP === */

/**
 * Le o diretorio central do ZIP e devolve um mapa nome -> Buffer.
 * Suporta os dois metodos que aparecem em .xlsx: 0 (sem compressao) e 8 (deflate).
 */
function abrirZip(buffer) {
  // O "end of central directory" fica no fim, depois de um comentario de
  // tamanho variavel, entao procuramos a assinatura de tras para frente.
  let eocd = -1;
  const limite = Math.max(0, buffer.length - 66_000);
  for (let i = buffer.length - 22; i >= limite; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('Arquivo .xlsx invalido (nao parece um ZIP).');

  const totalEntradas = buffer.readUInt16LE(eocd + 10);
  let ponteiro = buffer.readUInt32LE(eocd + 16);

  const arquivos = new Map();

  for (let n = 0; n < totalEntradas; n++) {
    if (buffer.readUInt32LE(ponteiro) !== 0x02014b50) break;

    const metodo = buffer.readUInt16LE(ponteiro + 10);
    const tamComprimido = buffer.readUInt32LE(ponteiro + 20);
    const tamNome = buffer.readUInt16LE(ponteiro + 28);
    const tamExtra = buffer.readUInt16LE(ponteiro + 30);
    const tamComentario = buffer.readUInt16LE(ponteiro + 32);
    const inicioLocal = buffer.readUInt32LE(ponteiro + 42);
    const nome = buffer.toString('utf8', ponteiro + 46, ponteiro + 46 + tamNome);

    // O cabecalho local repete nome e extra, com tamanhos proprios.
    const tamNomeLocal = buffer.readUInt16LE(inicioLocal + 26);
    const tamExtraLocal = buffer.readUInt16LE(inicioLocal + 28);
    const inicioDados = inicioLocal + 30 + tamNomeLocal + tamExtraLocal;
    const bruto = buffer.subarray(inicioDados, inicioDados + tamComprimido);

    try {
      arquivos.set(nome, metodo === 0 ? bruto : zlib.inflateRawSync(bruto));
    } catch {
      // Uma parte ilegivel nao invalida o arquivo todo.
    }

    ponteiro += 46 + tamNome + tamExtra + tamComentario;
  }

  return arquivos;
}

/* ================================================================= XLSX === */

const ENTIDADES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
};

function desescapar(texto) {
  return texto
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENTIDADES[m]);
}

/** Tabela de textos compartilhados: <si> pode ter varios <t> (texto formatado). */
function lerTextosCompartilhados(xml) {
  if (!xml) return [];
  const textos = [];
  for (const bloco of xml.split('<si>').slice(1)) {
    const fim = bloco.indexOf('</si>');
    const conteudo = fim === -1 ? bloco : bloco.slice(0, fim);
    let junto = '';
    for (const m of conteudo.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) junto += m[1];
    textos.push(desescapar(junto));
  }
  return textos;
}

// Formatos de data embutidos no Excel.
const FORMATOS_DATA = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/**
 * Descobre, por indice de estilo, se a celula e uma data. Precisa cruzar
 * cellXfs -> numFmtId, e olhar tambem os formatos customizados.
 */
function lerEstilosDeData(xml) {
  if (!xml) return new Set();

  const customDeData = new Set();
  for (const m of xml.matchAll(/<numFmt[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) {
    const codigo = desescapar(m[2]).replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"/g, '');
    if (/[dmyhs]/i.test(codigo) && /[dy]/i.test(codigo)) customDeData.add(Number(m[1]));
  }

  const bloco = xml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/);
  if (!bloco) return new Set();

  const estilos = new Set();
  let indice = 0;
  for (const m of bloco[1].matchAll(/<xf[^>]*>/g)) {
    const fmt = m[0].match(/numFmtId="(\d+)"/);
    const id = fmt ? Number(fmt[1]) : 0;
    if (FORMATOS_DATA.has(id) || customDeData.has(id)) estilos.add(indice);
    indice++;
  }
  return estilos;
}

/** "BC" -> 54. Converte a letra da coluna em indice base zero. */
function indiceDaColuna(ref) {
  const letras = ref.match(/^[A-Z]+/i)[0].toUpperCase();
  let n = 0;
  for (const ch of letras) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Numero de serie do Excel -> data. O sistema conta a partir de 1899-12-30. */
function serieParaData(n) {
  const ms = Math.round((n - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(n);

  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const aaaa = d.getUTCFullYear();

  const temHora = Math.abs(n - Math.floor(n)) > 1e-9;
  if (!temHora) return `${dd}/${mm}/${aaaa}`;

  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${aaaa} ${hh}:${mi}`;
}

function lerCelulas(xml, textos, estilosDeData) {
  const linhas = [];

  for (const mLinha of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const celulas = [];
    let maiorIndice = -1;

    for (const mCel of mLinha[1].matchAll(/<c([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = mCel[1];
      const corpo = mCel[2] || '';

      const ref = attrs.match(/r="([A-Z]+)\d+"/i);
      const indice = ref ? indiceDaColuna(ref[1]) : maiorIndice + 1;
      const tipo = (attrs.match(/t="([^"]+)"/) || [])[1];
      const estilo = Number((attrs.match(/s="(\d+)"/) || [])[1] ?? -1);

      let valor = '';
      if (tipo === 'inlineStr') {
        let junto = '';
        for (const m of corpo.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) junto += m[1];
        valor = desescapar(junto);
      } else {
        const v = corpo.match(/<v[^>]*>([\s\S]*?)<\/v>/);
        const bruto = v ? desescapar(v[1]) : '';

        if (tipo === 's') {
          valor = textos[Number(bruto)] ?? '';
        } else if (tipo === 'b') {
          valor = bruto === '1' ? 'VERDADEIRO' : 'FALSO';
        } else if (bruto !== '' && estilosDeData.has(estilo) && Number.isFinite(Number(bruto))) {
          valor = serieParaData(Number(bruto));
        } else {
          valor = bruto;
        }
      }

      celulas[indice] = String(valor).trim();
      if (indice > maiorIndice) maiorIndice = indice;
    }

    for (let i = 0; i <= maiorIndice; i++) if (celulas[i] === undefined) celulas[i] = '';
    linhas.push(celulas);
  }

  return linhas;
}

/** Nomes das abas na ordem, cruzando workbook.xml com os relacionamentos. */
function listarAbas(arquivos) {
  const workbook = arquivos.get('xl/workbook.xml')?.toString('utf8') || '';
  const rels = arquivos.get('xl/_rels/workbook.xml.rels')?.toString('utf8') || '';

  const alvoPorId = new Map();
  for (const m of rels.matchAll(/<Relationship([^>]*)\/>/g)) {
    const id = (m[1].match(/Id="([^"]+)"/) || [])[1];
    const alvo = (m[1].match(/Target="([^"]+)"/) || [])[1];
    if (id && alvo) {
      const caminho = alvo.startsWith('/')
        ? alvo.slice(1)
        : 'xl/' + alvo.replace(/^\.\//, '').replace(/^\/+/, '');
      alvoPorId.set(id, caminho);
    }
  }

  const abas = [];
  for (const m of workbook.matchAll(/<sheet([^>]*)\/>/g)) {
    const nome = (m[1].match(/name="([^"]*)"/) || [])[1];
    const rid = (m[1].match(/r:id="([^"]+)"/) || [])[1];
    const caminho = alvoPorId.get(rid);
    if (nome && caminho && arquivos.has(caminho)) abas.push({ nome, caminho });
  }

  // Sem workbook legivel, cai para o que existir de planilha no pacote.
  if (!abas.length) {
    for (const nome of arquivos.keys()) {
      if (/^xl\/worksheets\/sheet\d+\.xml$/.test(nome)) {
        abas.push({ nome: nome.replace(/^.*\//, '').replace('.xml', ''), caminho: nome });
      }
    }
  }

  return abas;
}

function lerXlsx(buffer, nomeAbaDesejada = null) {
  const arquivos = abrirZip(buffer);
  const abas = listarAbas(arquivos);

  if (!abas.length) throw new Error('Nenhuma aba encontrada no arquivo .xlsx.');

  const escolhida = abas.find((a) => a.nome === nomeAbaDesejada) || abas[0];
  const xml = arquivos.get(escolhida.caminho)?.toString('utf8');
  if (!xml) throw new Error(`Nao foi possivel ler a aba "${escolhida.nome}".`);

  const textos = lerTextosCompartilhados(arquivos.get('xl/sharedStrings.xml')?.toString('utf8'));
  const estilosDeData = lerEstilosDeData(arquivos.get('xl/styles.xml')?.toString('utf8'));

  const brutas = lerCelulas(xml, textos, estilosDeData)
    .filter((l) => l.some((c) => c !== ''));

  if (!brutas.length) {
    throw new Error(`A aba "${escolhida.nome}" esta vazia.`);
  }

  const colunas = nomearColunas(brutas[0]);
  const linhas = brutas.slice(1).map((l) => {
    const linha = new Array(colunas.length).fill('');
    for (let i = 0; i < colunas.length; i++) linha[i] = l[i] ?? '';
    return linha;
  });

  return {
    colunas,
    linhas,
    abas: abas.map((a) => a.nome),
    aba: escolhida.nome,
    separador: null,
  };
}

/* ================================================================ porta === */

/** Escolhe o leitor pelo nome do arquivo, com o conteudo como desempate. */
function ler(buffer, nomeArquivo = '', aba = null) {
  const ehXlsx =
    /\.xlsx$/i.test(nomeArquivo) ||
    (buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b);

  if (/\.xls$/i.test(nomeArquivo) && !ehXlsx) {
    throw new Error(
      'Formato .xls antigo nao e suportado. Salve como .xlsx ou .csv e tente de novo.'
    );
  }

  return ehXlsx ? lerXlsx(buffer, aba) : lerTexto(buffer);
}

module.exports = { ler, lerTexto, lerXlsx, abrirZip };
