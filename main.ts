// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's text as its lines, its line break and whether it ends with one (SPEC.md section 3). */
interface FileParts {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(f: FileParts): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** One line of a replacement, with the index into O when it is a context line, else -1. */
interface NewLine {
  text: string;
  ctx: number;
}

const leadOf = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** A line read at a matching tier (SPEC.md section 5). */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  const t = s.replace(/[ \t]+$/, '');
  return tier === 1 ? t : t.replace(/^[ \t]+/, '');
}

/** Every 0-based position where O occurs in F at the given tier; O is non-empty. */
function occurrences(F: string[], O: string[], tier: number): number[] {
  const out: number[] = [];
  const want = O.map((l) => normLine(l, tier));
  for (let i = 0; i + O.length <= F.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (normLine(F[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/**
 * The first tier at which O occurs in F, with its occurrences; null when it occurs at no tier.
 * With strict only tier 0 is tried. Occurrences start at or after `from` (0 by default), and
 * when `eof` is set only occurrences ending at the file's last line count.
 */
function findTier(
  F: string[],
  O: string[],
  strict: boolean,
  from = 0,
  eof = false,
): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = occurrences(F, O, t).filter((p) => p >= from && (!eof || p + O.length === F.length));
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/**
 * The replacement lines for O matched at position `at` in F: a context line is written as the
 * file's own matched line, and at tier 2 every other line is re-indented from O's first line's
 * leading whitespace to the file's first matched line's (SPEC.md section 5).
 */
function replacementLines(F: string[], O: string[], N: NewLine[], tier: number, at: number): string[] {
  if (tier !== 2) return N.map((nl) => (nl.ctx >= 0 ? F[at + nl.ctx]! : nl.text));
  const fLead = leadOf(F[at]!);
  const pLead = leadOf(O[0]!);
  return N.map((nl) => {
    if (nl.ctx >= 0) return F[at + nl.ctx]!;
    const t = nl.text;
    if (t !== '' && t.trim() !== '' && t.startsWith(pLead)) return fLead + t.slice(pLead.length);
    return t;
  });
}

/** Split a hunk or chunk body into its old lines O and its new lines N (SPEC.md sections 6 and 8). */
interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  /** The raw patch line was empty (no characters at all). */
  blank: boolean;
}

function splitBody(body: BodyLine[]): { O: string[]; N: NewLine[] } {
  const O: string[] = [];
  const N: NewLine[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      O.push(b.text);
      N.push({ text: b.text, ctx: O.length - 1 });
    } else if (b.kind === '-') {
      O.push(b.text);
    } else if (b.kind === '+') {
      N.push({ text: b.text, ctx: -1 });
    }
  }
  return { O, N };
}

/** Whether a `\` line follows the hunk's last context or `+` line (SPEC.md section 6). */
function noNewlineAfter(body: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i]!.kind === ' ' || body[i]!.kind === '+') last = i;
  }
  return last >= 0 && body[last + 1] !== undefined && body[last + 1]!.kind === '\\';
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a successful move edit made, as (old path, new path) pairs, in patch order. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One hunk of a unified diff section (SPEC.md section 6). */
interface Hunk {
  a: number;
  body: BodyLine[];
}

interface RawSection {
  oldRaw: string | null | undefined;
  newRaw: string | null | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function newSection(): RawSection {
  return {
    oldRaw: undefined,
    newRaw: undefined,
    renameFrom: null,
    renameTo: null,
    diffOld: null,
    diffNew: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
  };
}

/** A `--- ` or `+++ ` path: the text after the four characters, up to the first tab, spaces removed. */
function diffPath(line: string): string | null {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const hunkHead = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const sections: RawSection[] = [];
  let cur: RawSection | null = null;
  let inHeader = false;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || !inHeader || cur.oldRaw !== undefined) {
        cur = newSection();
        sections.push(cur);
      }
      cur.oldRaw = diffPath(line);
      cur.newRaw = diffPath(lines[i + 1]!);
      inHeader = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkHead.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: BodyLine[] = [];
      i += 1;
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') body.push({ kind: ' ', text: '', blank: true });
        else if (b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          body.push({ kind: b[0] as ' ' | '-' | '+' | '\\', text: b.slice(1), blank: false });
        } else break;
        i += 1;
      }
      while (body.length > 0 && body[body.length - 1]!.blank) body.pop();
      cur.hunks.push({ a: Number(m[1]), body });
      inHeader = false;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) cur.newRaw = diffPath(line);
      else if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Apply one section's hunks in order to a file's text (SPEC.md section 6). */
function applyUnifiedHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const { O, N } = splitBody(h.body);
    if (O.length > 0) {
      const found = findTier(f.lines, O, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const rep = replacementLines(f.lines, O, N, found.tier, best);
      if (best + O.length === f.lines.length) f.final = !noNewlineAfter(h.body);
      f.lines.splice(best, O.length, ...rep);
      d += N.length - O.length;
    } else {
      const pos = Math.max(0, Math.min(h.a + d, f.lines.length));
      const rep = N.map((nl) => nl.text);
      if (pos === f.lines.length && N.length > 0) f.final = !noNewlineAfter(h.body);
      f.lines.splice(pos, 0, ...rep);
      d += N.length;
    }
  }
  return joinFile(f);
}

function unifiedEdit(s: RawSection, strict: boolean): Edit {
  const oldP = s.oldRaw !== undefined ? s.oldRaw : s.renameFrom ?? s.diffOld;
  const newP = s.newRaw !== undefined ? s.newRaw : s.renameTo ?? s.diffNew;
  const isCreate = oldP === null || s.newFile;
  const isDelete = !isCreate && (newP === null || s.deletedFile);
  const isMove = !isCreate && !isDelete && oldP !== newP;
  return (tree) => {
    if (isCreate) {
      const p = newP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of s.hunks) {
        for (const b of h.body) if (b.kind === '+') plus.push(b.text);
      }
      let finalBreak = true;
      outer: for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
        const body = s.hunks[hi]!.body;
        for (let bi = body.length - 1; bi >= 0; bi--) {
          if (body[bi]!.kind === '+') {
            finalBreak = !(body[bi + 1] !== undefined && body[bi + 1]!.kind === '\\');
            break outer;
          }
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (finalBreak ? '\n' : ''));
      return;
    }
    if (isDelete) {
      const p = oldP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const p = oldP!;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (isMove) {
      const q = newP!;
      if (!safe(q)) throw new Fail('unsafe', q);
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (isMove && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    const out = applyUnifiedHunks(before, s.hunks, strict, p);
    if (isMove) {
      tree.now.set(newP!, out);
      tree.now.set(p, null);
      tree.moves.push([p, newP!]);
    } else {
      tree.now.set(p, out);
    }
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (l.trim() === '') continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(searchLine + 1, sep), lines.slice(sep + 1, end), strict));
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const rep = replacementLines(
      f.lines,
      oldLines,
      newLines.map((t) => ({ text: t, ctx: -1 })),
      found.tier,
      at,
    );
    f.lines.splice(at, oldLines.length, ...rep);
    tree.now.set(path, joinFile(f));
  };
}

/** One chunk of a V4A Update File section (SPEC.md section 8). */
interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function v4aBodyLine(text: string): BodyLine | null {
  if (text === '') return { kind: ' ', text: '', blank: true };
  if (text[0] === ' ' || text[0] === '-' || text[0] === '+') {
    return { kind: text[0] as ' ' | '-' | '+', text: text.slice(1), blank: false };
  }
  return null;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const l = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice('*** Add File: '.length).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = l.slice('*** Delete File: '.length).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      path = l.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const secLine = i + 1;
    i++;
    const body: Array<{ text: string; no: number }> = [];
    while (i < last) {
      const t = lines[i]!;
      if (t.startsWith('*** Add File: ') || t.startsWith('*** Delete File: ') || t.startsWith('*** Update File: ')) break;
      body.push({ text: t, no: i + 1 });
      i++;
    }
    while (body.length > 0 && blank(body[body.length - 1]!.text)) body.pop();
    edits.push(v4aEdit(kind, path, body, secLine, strict));
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function v4aEdit(
  kind: 'add' | 'delete' | 'update',
  path: string,
  body: Array<{ text: string; no: number }>,
  secLine: number,
  strict: boolean,
): Edit {
  if (kind === 'add') {
    const content: string[] = [];
    for (const b of body) {
      if (b.text.startsWith('+')) content.push(b.text.slice(1));
      else if (b.text === '') content.push('');
      else throw new Exit2(`error: parse ${b.no}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
    };
  }
  if (kind === 'delete') {
    if (body.length > 0) throw new Exit2(`error: parse ${body[0]!.no}`);
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  let idx = 0;
  let moveTo: string | null = null;
  if (body.length > 0 && body[0]!.text.startsWith('*** Move to: ')) {
    moveTo = body[0]!.text.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  let closed = false;
  while (idx < body.length) {
    const b = body[idx]!;
    if (b.text.startsWith('@@')) {
      const anchor = b.text.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      chunks.push(cur);
      closed = false;
      idx++;
      continue;
    }
    if (b.text === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${b.no}`);
      cur.eof = true;
      closed = true;
      idx++;
      continue;
    }
    const bl = v4aBodyLine(b.text);
    if (bl === null) throw new Exit2(`error: parse ${b.no}`);
    if (cur === null) {
      cur = { anchor: null, eof: false, body: [] };
      chunks.push(cur);
      closed = false;
    } else if (closed) {
      throw new Exit2(`error: parse ${b.no}`);
    }
    cur.body.push(bl);
    idx++;
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTier(f.lines, [ch.anchor], strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.occ[0]! + 1;
      }
      const { O, N } = splitBody(ch.body);
      if (O.length > 0) {
        const found = findTier(f.lines, O, strict, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const at = found.occ[0]!;
        const rep = replacementLines(f.lines, O, N, found.tier, at);
        f.lines.splice(at, O.length, ...rep);
        cursor = at + rep.length;
      } else {
        const pos = ch.eof ? f.lines.length : cursor;
        const rep = N.map((nl) => nl.text);
        f.lines.splice(pos, 0, ...rep);
        cursor = pos + rep.length;
      }
    }
    const out = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows = new Map<string, { key: string; line: string }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.set(p, { key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  const next = new Map<string, string>();
  for (const [o, n] of tree.moves) next.set(o, n);
  const isTarget = new Set(tree.moves.map(([, n]) => n));
  for (const [o] of tree.moves) {
    if (isTarget.has(o)) continue;
    const seen = new Set<string>([o]);
    let end = o;
    let cyclic = false;
    while (next.has(end)) {
      const nx = next.get(end)!;
      if (seen.has(nx)) {
        cyclic = true;
        break;
      }
      seen.add(nx);
      end = nx;
    }
    if (cyclic || end === o) continue;
    if (tree.original(o) === null || tree.original(end) !== null) continue;
    if (tree.get(o) !== null || tree.get(end) === null) continue;
    rows.delete(o);
    rows.delete(end);
    rows.set(end, { key: end, line: `R ${o} -> ${end}` });
  }
  const sorted = [...rows.values()].sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = sorted.map((r) => r.line);
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
