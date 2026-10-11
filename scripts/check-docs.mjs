import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Numeric spellings keep rule definitions out of the text they inspect.
const restrictedTerms = new Set(
  [
    [65, 73],
    [76, 76, 77],
    [71, 80, 84],
    [67, 104, 97, 116, 71, 80, 84],
    [79, 112, 101, 110, 65, 73],
    [65, 110, 116, 104, 114, 111, 112, 105, 99],
    [67, 108, 97, 117, 100, 101],
    [67, 111, 100, 101, 120],
    [71, 101, 109, 105, 110, 105],
    [67, 111, 112, 105, 108, 111, 116],
    [
      97, 114, 116, 105, 102, 105, 99, 105, 97, 108, 105, 110, 116, 101, 108, 108, 105, 103, 101,
      110, 99, 101,
    ],
    [108, 97, 114, 103, 101, 108, 97, 110, 103, 117, 97, 103, 101, 109, 111, 100, 101, 108],
  ].map((codes) => String.fromCharCode(...codes).toLowerCase()),
);
const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'coverage', '.nos-undo']);
const legalName = /^(?:LICENSE|LICENCE|COPYING|COPYRIGHT|NOTICE)(?:\.(?:md|txt))?$/i;
const secretName = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i;
const diagnostics = [];
let files = 0;
let links = 0;
let excluded = 0;
let root;

function report(path, line, column, code, message) {
  diagnostics.push({ path, line, column, code, message });
}

function position(text, offset) {
  const prefix = text.slice(0, offset);
  return [prefix.split('\n').length, offset - prefix.lastIndexOf('\n')];
}

function vocabulary(path, text, code = 'VOCABULARY') {
  for (const [index, line] of text.split('\n').entries()) {
    const tokens = [
      ...line.matchAll(/[A-Z]+(?=[A-Z][a-z]|[^A-Za-z]|$)|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g),
    ];
    for (let start = 0; start < tokens.length; start++) {
      let phrase = '';
      for (let end = start; end < Math.min(start + 3, tokens.length); end++) {
        if (end > start) {
          const previous = tokens[end - 1];
          const gap = line.slice(previous.index + previous[0].length, tokens[end].index);
          if (!/^[\s_-]*$/.test(gap)) break;
        }
        phrase += tokens[end][0].toLowerCase();
        if (restrictedTerms.has(phrase)) {
          report(
            path,
            index + 1,
            tokens[start].index + 1,
            code,
            'Restricted terminology; use schema-domain wording.',
          );
          break;
        }
      }
    }
  }
}

function insideRoot(path) {
  const local = relative(root, path);
  return !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`);
}

function escaped(text, index) {
  let slashes = 0;
  while (index > 0 && text[--index] === '\\') slashes++;
  return slashes % 2 === 1;
}

function blank(text) {
  return text.replace(/[^\r\n]/g, ' ');
}

function prose(path, text) {
  let fence;
  let offset = 0;
  const lines = text.split(/(?<=\n)/);
  const masked = lines
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/.exec(line);
      if (fence) {
        if (
          marker &&
          marker[1][0] === fence.kind &&
          marker[1].length >= fence.length &&
          !marker[2].trim()
        )
          fence = undefined;
        offset += line.length;
        return blank(line);
      }
      if (marker && (marker[1][0] !== '`' || !marker[2].includes('`'))) {
        fence = { kind: marker[1][0], length: marker[1].length, offset };
        offset += line.length;
        return blank(line);
      }
      offset += line.length;
      return /^(?: {4}|\t)/.test(line) ? blank(line) : line;
    })
    .join('');
  if (fence)
    report(path, ...position(text, fence.offset), 'DOC_FENCE', 'Unclosed Markdown code fence.');

  // Equal-length masks retain source locations while excluding example syntax.
  let result = masked.replace(/<!--[\s\S]*?-->/g, blank);
  const runs = /`+/g;
  let match;
  while ((match = runs.exec(result))) {
    if (escaped(result, match.index)) continue;
    const closing = new RegExp(`(?<!\u0060)\u0060{${match[0].length}}(?!\u0060)`, 'g');
    closing.lastIndex = runs.lastIndex;
    const end = closing.exec(result);
    if (!end) continue;
    const stop = end.index + end[0].length;
    result =
      result.slice(0, match.index) + blank(result.slice(match.index, stop)) + result.slice(stop);
    runs.lastIndex = stop;
  }
  return result;
}

function destination(text, start) {
  let cursor = start;
  while (/\s/.test(text[cursor] ?? '') && cursor < text.length) cursor++;
  if (text[cursor] === '<') {
    const end = text.indexOf('>', cursor + 1);
    if (end < 0 || text.slice(cursor, end).includes('\n')) return undefined;
    return { value: text.slice(cursor + 1, end), end: end + 1 };
  }
  const begin = cursor;
  let depth = 0;
  while (cursor < text.length) {
    const char = text[cursor];
    if (char === '\\' && cursor + 1 < text.length) {
      cursor += 2;
      continue;
    }
    if (/\s/.test(char)) break;
    if (char === '(') depth++;
    if (char === ')') {
      if (!depth) break;
      depth--;
    }
    cursor++;
  }
  if (depth) return undefined;
  return { value: text.slice(begin, cursor), end: cursor };
}

function checkLink(path, text, offset, target) {
  if (
    !target ||
    target.startsWith('#') ||
    target.startsWith('//') ||
    /^[a-z][a-z\d+.-]*:/i.test(target)
  )
    return;
  links++;
  const location = position(text, offset);
  let decoded;
  try {
    decoded = decodeURIComponent(
      target.split(/[?#]/, 1)[0].replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, '$1'),
    );
  } catch {
    report(path, ...location, 'DOC_LINK', 'Invalid URL encoding in local link.');
    return;
  }
  const absolute = decoded.startsWith('/')
    ? resolve(root, `.${decoded}`)
    : resolve(root, dirname(path), decoded);
  if (!insideRoot(absolute)) {
    report(path, ...location, 'DOC_LINK', 'Local link escapes the checkout.');
    return;
  }
  try {
    if (!insideRoot(realpathSync(absolute))) {
      report(path, ...location, 'DOC_LINK', 'Local link resolves outside the checkout.');
    }
  } catch (error) {
    report(path, ...location, 'DOC_LINK', `Local link target is unavailable (${error.code}).`);
  }
}

function markdown(path, text) {
  let masked = prose(path, text);
  const definitions = new Map();
  const normalize = (label) => label.trim().replace(/\s+/g, ' ').toLowerCase();
  masked = masked.replace(/^ {0,3}\[([^\]\n]+)\]:([^\n]*)$/gm, (line, label, value) => {
    const target = destination(value, 0);
    if (target && !definitions.has(normalize(label)))
      definitions.set(normalize(label), target.value);
    return blank(line);
  });
  const labels = /!?\[([^\]\n]*)\]/g;
  let match;
  while ((match = labels.exec(masked))) {
    if (escaped(masked, match.index)) continue;
    const after = labels.lastIndex;
    if (masked[after] === '(') {
      const target = destination(masked, after + 1);
      const suffix =
        target &&
        /^\s*(?:(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\))\s*)?\)/.exec(masked.slice(target.end));
      if (!suffix) {
        report(
          path,
          ...position(text, match.index),
          'DOC_LINK_SYNTAX',
          'Malformed inline Markdown link.',
        );
        continue;
      }
      checkLink(path, text, match.index, target.value);
      labels.lastIndex = target.end + suffix[0].length;
    } else if (masked[after] === '[') {
      const reference = /^\[([^\]\n]*)\]/.exec(masked.slice(after));
      if (!reference) continue;
      const label = normalize(reference[1] || match[1]);
      const citation = /^\d+$/.test(match[1]) && /^\d+$/.test(reference[1]);
      if (!definitions.has(label) && !citation)
        report(
          path,
          ...position(text, match.index),
          'DOC_REFERENCE',
          'Undefined Markdown link reference.',
        );
      else checkLink(path, text, match.index, definitions.get(label));
      labels.lastIndex = after + reference[0].length;
    } else if (definitions.has(normalize(match[1]))) {
      checkLink(path, text, match.index, definitions.get(normalize(match[1])));
    }
  }
}

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    if (ignoredDirectories.has(entry.name) || secretName.test(entry.name)) {
      excluded++;
      continue;
    }
    const absolute = join(directory, entry.name);
    const path = relative(root, absolute).split(sep).join('/');
    if (entry.isSymbolicLink()) {
      report(
        path,
        1,
        1,
        'CHECK_SYMLINK',
        'Symbolic links are not followed; use repository-owned files.',
      );
    } else if (entry.isDirectory()) {
      walk(absolute);
    } else if (entry.isFile()) {
      if (legalName.test(basename(path))) {
        excluded++;
        continue;
      }
      vocabulary(path, path, 'VOCABULARY_PATH');
      const bytes = readFileSync(absolute);
      let text;
      try {
        if (bytes.includes(0)) throw new Error('Binary file');
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        excluded++;
        continue;
      }
      files++;
      vocabulary(path, text);
      if (/\.md$/i.test(path)) markdown(path, text);
    }
  }
}

try {
  if (process.argv.length > 3)
    throw new Error('Usage: node scripts/check-docs.mjs [checkout-root]');
  root = realpathSync(resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url))));
  if (!statSync(root).isDirectory()) throw new Error('Checkout root must be a directory.');
  walk(root);
} catch (error) {
  report(
    '.',
    1,
    1,
    'CHECK_IO',
    `Cannot complete documentation check (${error.code ?? error.message}).`,
  );
}

diagnostics.sort(
  (a, b) =>
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
    a.line - b.line ||
    a.column - b.column ||
    a.code.localeCompare(b.code),
);
if (diagnostics.length) {
  for (const item of diagnostics)
    console.error(`${item.path}:${item.line}:${item.column} ${item.code} ${item.message}`);
  console.error(
    `FAIL: ${diagnostics.length} documentation/vocabulary finding(s). No files changed.`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `PASS: documentation/vocabulary (${files} text files, ${links} local links, ${excluded} excluded entries). No files changed.`,
  );
}
