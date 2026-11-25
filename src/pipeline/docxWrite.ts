/**
 * The brain writes a Word file as HTML. This packs that HTML into a .docx:
 * headings, paragraphs, lists, tables, and pictures. CSS page layout is not printed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  UnderlineType,
  WidthType,
  type IParagraphOptions,
} from "docx";
import { convertImage, sniffImage, type ImageFormat } from "./mediaFormat";
import { recordPlatformNote } from "./platformNotes";

const COLUMN_PX = 624;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const SKIP = new Set(["script", "style", "noscript", "template"]);
const CLOSES_P = new Set([
  "address", "article", "aside", "blockquote", "div", "dl", "fieldset", "figcaption", "figure", "footer", "form",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "nav", "ol", "p", "pre", "section", "table", "ul",
]);
const BLOCK = new Set([
  ...CLOSES_P,
  "dd", "dt", "hgroup", "li", "tbody", "td", "tfoot", "th", "thead", "tr",
]);

const HEADING = {
  h1: HeadingLevel.HEADING_1,
  h2: HeadingLevel.HEADING_2,
  h3: HeadingLevel.HEADING_3,
  h4: HeadingLevel.HEADING_4,
  h5: HeadingLevel.HEADING_5,
  h6: HeadingLevel.HEADING_6,
} as const;

type TextNode = { kind: "text"; text: string };
type El = { kind: "el"; tag: string; attrs: Record<string, string>; children: HtmlNode[] };
type HtmlNode = TextNode | El;
type Marks = {
  bold?: boolean;
  italics?: boolean;
  underline?: boolean;
  strike?: boolean;
  superScript?: boolean;
  subScript?: boolean;
  color?: string;
  size?: number;
  font?: string;
};
type Align = (typeof AlignmentType)[keyof typeof AlignmentType];
type ListCfg = {
  reference: string;
  levels: Array<{
    level: number;
    format: (typeof LevelFormat)[keyof typeof LevelFormat];
    text: string;
    style: { paragraph: { indent: { left: number; hanging: number } } };
  }>;
};
type Ctx = {
  baseDir: string;
  scratch: string;
  seq: { n: number };
  marks: Marks;
  align?: Align;
  quote: boolean;
  pre: boolean;
  breakBefore: boolean;
  list?: { cfg: ListCfg; depth: number };
};

type Block = Paragraph | Table;

export async function htmlToDocx(html: string, opts: { baseDir: string }): Promise<Buffer> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "autocook-docx-"));
  try {
    const lists: ListCfg[] = [];
    const ctx: Ctx = {
      baseDir: opts.baseDir,
      scratch,
      seq: { n: 0 },
      marks: {},
      quote: false,
      pre: false,
      breakBefore: false,
    };
    const children = await blocksFrom(parseHtml(html), ctx, lists);
    const doc = new Document({
      numbering: { config: lists },
      sections: [{ children: children.length ? children : [new Paragraph({})] }],
    });
    return await Packer.toBuffer(doc);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function parseHtml(html: string): HtmlNode[] {
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  const source = (body ? body[1]! : html.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, "")).replace(/<!--[\s\S]*?-->/g, "");
  const roots: HtmlNode[] = [];
  const stack: El[] = [];
  let i = 0;
  while (i < source.length) {
    if (source[i] !== "<") {
      const next = source.indexOf("<", i);
      const raw = source.slice(i, next < 0 ? source.length : next);
      const text = decodeEntities(raw);
      if (text) (stack[stack.length - 1]?.children ?? roots).push({ kind: "text", text });
      i = next < 0 ? source.length : next;
      continue;
    }
    if (source.startsWith("<!", i) || source.startsWith("<?", i)) {
      const gt = source.indexOf(">", i);
      i = gt < 0 ? source.length : gt + 1;
      continue;
    }
    const gt = readUntilGt(source, i + 1);
    if (gt < 0) break;
    const rawTag = source.slice(i + 1, gt).trim();
    i = gt + 1;
    if (!rawTag) continue;
    if (rawTag.startsWith("/")) {
      const name = rawTag.slice(1).trim().split(/\s/)[0]?.toLowerCase() ?? "";
      for (let s = stack.length - 1; s >= 0; s--) {
        if (stack[s]!.tag === name) {
          stack.length = s;
          break;
        }
      }
      continue;
    }
    const nameMatch = /^([A-Za-z][\w:-]*)/.exec(rawTag);
    if (!nameMatch) continue;
    const tag = nameMatch[1]!.toLowerCase();
    if (SKIP.has(tag)) {
      const close = new RegExp(`</${tag}\\s*>`, "i").exec(source.slice(i));
      i = close ? i + close.index + close[0].length : source.length;
      continue;
    }
    const el: El = { kind: "el", tag, attrs: readAttrs(rawTag.slice(nameMatch[0].length)), children: [] };
    if (CLOSES_P.has(tag)) {
      while (stack.length && stack[stack.length - 1]!.tag === "p") stack.pop();
    }
    (stack[stack.length - 1]?.children ?? roots).push(el);
    const selfClose = rawTag.endsWith("/") || VOID.has(tag);
    if (!selfClose) stack.push(el);
  }
  return roots;
}

function readUntilGt(source: string, start: number): number {
  let quote = "";
  for (let j = start; j < source.length; j++) {
    const c = source[j]!;
    if (quote) {
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === ">") return j;
  }
  return -1;
}

function readAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    attrs[match[1]!.toLowerCase()] = decodeEntities(value);
  }
  return attrs;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, "\u00A0")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => fromCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => fromCode(parseInt(n, 16)))
    .replace(/&amp;/gi, "&");
}

function fromCode(n: number): string {
  try {
    return Number.isFinite(n) ? String.fromCodePoint(n) : "";
  } catch {
    return "";
  }
}

async function blocksFrom(nodes: HtmlNode[], ctx: Ctx, lists: ListCfg[]): Promise<Block[]> {
  const out: Block[] = [];
  let pending: HtmlNode[] = [];
  const flush = async () => {
    if (!pending.some((node) => node.kind === "el" || node.text.trim())) {
      pending = [];
      return;
    }
    const nodes = pending;
    pending = [];
    out.push(await paragraphFrom(nodes, ctx));
  };
  for (const node of nodes) {
    if (node.kind === "text") {
      if (node.text.trim() || pending.length) pending.push(node);
      continue;
    }
    if (BLOCK.has(node.tag) && node.tag !== "li") {
      await flush();
      out.push(...(await blockFrom(node, ctx, lists)));
    } else {
      pending.push(node);
    }
  }
  await flush();
  return out;
}

async function blockFrom(el: El, ctx: Ctx, lists: ListCfg[]): Promise<Block[]> {
  const next = childCtx(el, ctx);
  next.breakBefore = takeBreak(ctx, el);
  const heading = HEADING[el.tag as keyof typeof HEADING];
  if (heading || el.tag === "p" || el.tag === "dt" || el.tag === "dd" || el.tag === "figcaption") {
    if (el.tag === "dt") next.marks = { ...next.marks, bold: true };
    return [await paragraphFrom(el.children, next, { heading })];
  }
  if (el.tag === "pre") return [await preParagraph(el, next)];
  if (el.tag === "hr") {
    const para = new Paragraph({
      pageBreakBefore: consumeBreak(next),
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, space: 1, color: "000000" } },
    });
    return [para];
  }
  if (el.tag === "ul" || el.tag === "ol") return listBlocks(el, next, lists);
  if (el.tag === "table") {
    const table = await tableFrom(el, next, lists);
    if (!next.breakBefore) return table ? [table] : [];
    next.breakBefore = false;
    return table ? [new Paragraph({ pageBreakBefore: true }), table] : [];
  }
  if (el.tag === "blockquote") next.quote = true;
  return blocksFrom(el.children, next, lists);
}

async function listBlocks(el: El, ctx: Ctx, lists: ListCfg[]): Promise<Block[]> {
  const cfg = ctx.list?.cfg ?? { reference: `list-${lists.length + 1}`, levels: [] };
  const depth = ctx.list ? ctx.list.depth + 1 : 0;
  if (!ctx.list) lists.push(cfg);
  const ordered = el.tag === "ol";
  cfg.levels[depth] = {
    level: depth,
    format: ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
    text: ordered ? `%${depth + 1}.` : "•",
    style: { paragraph: { indent: { left: 720 * (depth + 1), hanging: 360 } } },
  };
  const itemCtx: Ctx = { ...ctx, list: { cfg, depth }, breakBefore: ctx.breakBefore };
  const out: Block[] = [];
  const items = el.children.filter((node): node is El => node.kind === "el" && node.tag === "li");
  for (const [index, li] of items.entries()) {
    if (index > 0) itemCtx.breakBefore = false;
    out.push(...(await listItem(li, itemCtx, lists)));
  }
  ctx.breakBefore = false;
  return out;
}

async function listItem(li: El, ctx: Ctx, lists: ListCfg[]): Promise<Block[]> {
  const next = childCtx(li, ctx);
  next.list = ctx.list;
  next.breakBefore = ctx.breakBefore;
  const out: Block[] = [];
  let numbered = false;
  let pending: HtmlNode[] = [];
  const flush = async () => {
    if (!pending.some((node) => node.kind === "el" || node.text.trim())) {
      pending = [];
      return;
    }
    const nodes = pending;
    pending = [];
    out.push(await paragraphFrom(nodes, next, numbered ? undefined : { numbering: true }));
    next.breakBefore = false;
    numbered = true;
  };
  for (const node of li.children) {
    if (node.kind === "el" && (node.tag === "ul" || node.tag === "ol")) {
      await flush();
      out.push(...(await listBlocks(node, next, lists)));
      continue;
    }
    if (node.kind === "el" && node.tag === "p") {
      await flush();
      const pCtx = childCtx(node, next);
      pCtx.list = next.list;
      pCtx.breakBefore = next.breakBefore;
      out.push(await paragraphFrom(node.children, pCtx, numbered ? undefined : { numbering: true }));
      next.breakBefore = false;
      numbered = true;
      continue;
    }
    if (node.kind === "el" && BLOCK.has(node.tag)) {
      await flush();
      out.push(...(await blockFrom(node, next, lists)));
      numbered = true;
      continue;
    }
    pending.push(node);
  }
  await flush();
  if (!numbered && !out.length) out.push(await paragraphFrom([], next, { numbering: true }));
  ctx.breakBefore = false;
  return out;
}

async function tableFrom(el: El, ctx: Ctx, lists: ListCfg[]): Promise<Table | null> {
  const rows = rowElements(el);
  if (!rows.length) return null;
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: await Promise.all(
      rows.map(async (row) => {
        const cells = row.children.filter((node): node is El => node.kind === "el" && (node.tag === "td" || node.tag === "th"));
        return new TableRow({
          children: await Promise.all(
            cells.map(async (cell) => {
              const cellCtx = childCtx(cell, ctx);
              cellCtx.breakBefore = false;
              const inner = await blocksFrom(cell.children, cellCtx, lists);
              const span = positive(cell.attrs.colspan);
              const down = positive(cell.attrs.rowspan);
              return new TableCell({
                children: inner.length ? inner : [new Paragraph({})],
                width: { size: Math.max(1, Math.round(100 / Math.max(1, cells.length))), type: WidthType.PERCENTAGE },
                ...(span ? { columnSpan: span } : {}),
                ...(down ? { rowSpan: down } : {}),
              });
            }),
          ),
        });
      }),
    ),
  });
}

function rowElements(table: El): El[] {
  const rows: El[] = [];
  for (const child of table.children) {
    if (child.kind !== "el") continue;
    if (child.tag === "tr") rows.push(child);
    else if (child.tag === "thead" || child.tag === "tbody" || child.tag === "tfoot") {
      for (const row of child.children) if (row.kind === "el" && row.tag === "tr") rows.push(row);
    }
  }
  return rows;
}

async function preParagraph(el: El, ctx: Ctx): Promise<Paragraph> {
  const text = collectText(el).replace(/\r\n/g, "\n").replace(/^\n/, "").replace(/\n$/, "");
  const lines = text.split("\n");
  const children: TextRun[] = [];
  lines.forEach((line, index) => {
    if (index) children.push(new TextRun({ break: 1 }));
    children.push(textRun(line.length ? line : " ", ctx.marks));
  });
  return new Paragraph({
    alignment: ctx.align,
    pageBreakBefore: consumeBreak(ctx),
    indent: ctx.quote ? { left: 720 } : undefined,
    children,
  });
}

async function paragraphFrom(
  nodes: HtmlNode[],
  ctx: Ctx,
  extra?: { heading?: (typeof HeadingLevel)[keyof typeof HeadingLevel]; numbering?: boolean },
): Promise<Paragraph> {
  const children = await inlines(trimmed(nodes), ctx);
  const numbering = extra?.numbering && ctx.list ? { reference: ctx.list.cfg.reference, level: ctx.list.depth } : undefined;
  const options: IParagraphOptions = {
    heading: extra?.heading,
    alignment: ctx.align,
    numbering,
    pageBreakBefore: consumeBreak(ctx) || undefined,
    indent: ctx.quote && !numbering ? { left: 720 } : undefined,
    children: children.length ? children : [new TextRun("")],
  };
  return new Paragraph(options);
}

async function inlines(nodes: HtmlNode[], ctx: Ctx): Promise<Array<TextRun | ImageRun | ExternalHyperlink>> {
  const out: Array<TextRun | ImageRun | ExternalHyperlink> = [];
  for (const node of nodes) {
    if (node.kind === "text") {
      const text = ctx.pre ? node.text : node.text.replace(/\s+/g, " ");
      if (!text) continue;
      out.push(textRun(text, ctx.marks));
      continue;
    }
    if (node.tag === "br") {
      out.push(new TextRun({ break: 1 }));
      continue;
    }
    if (node.tag === "img") {
      const image = await imageRun(node, ctx);
      if (image) out.push(image);
      continue;
    }
    if (BLOCK.has(node.tag)) continue;
    const inner = childCtx(node, ctx);
    const kids = await inlines(node.children, inner);
    if (node.tag === "a") {
      const href = node.attrs.href?.trim();
      if (href && kids.length) out.push(new ExternalHyperlink({ link: href, children: kids }));
      else out.push(...kids);
      continue;
    }
    out.push(...kids);
  }
  return out;
}

function textRun(text: string, marks: Marks): TextRun {
  return new TextRun({
    text,
    bold: marks.bold,
    italics: marks.italics,
    underline: marks.underline ? { type: UnderlineType.SINGLE } : undefined,
    strike: marks.strike,
    superScript: marks.superScript,
    subScript: marks.subScript,
    color: marks.color,
    size: marks.size,
    font: marks.font,
  });
}

async function imageRun(el: El, ctx: Ctx): Promise<ImageRun | null> {
  const src = el.attrs.src?.trim() ?? "";
  if (!src) return null;
  if (/^https?:\/\//i.test(src)) throw new Error(`picture ${src} is a remote address; place it with {{asset:id}}`);
  const loaded = await loadPicture(src, ctx);
  const asked = imgPixels(el);
  const meta = loaded.width > 0 && loaded.height > 0 ? loaded : { ...loaded, width: asked.w ?? COLUMN_PX, height: asked.h ?? COLUMN_PX };
  let width = meta.width;
  let height = meta.height;
  if (asked.w && asked.h) {
    width = asked.w;
    height = asked.h;
  } else if (asked.w) {
    height = Math.max(1, Math.round(meta.height * (asked.w / meta.width)));
    width = asked.w;
  } else if (asked.h) {
    width = Math.max(1, Math.round(meta.width * (asked.h / meta.height)));
    height = asked.h;
  } else if (width > COLUMN_PX) {
    const scale = COLUMN_PX / width;
    height = Math.max(1, Math.round(height * scale));
    width = COLUMN_PX;
    const label = src.startsWith("data:") ? "inline picture" : path.basename(src.split("?")[0] ?? src);
    recordPlatformNote(`Picture ${label} was wider than the text column and was scaled to fit.`);
  }
  const alt = el.attrs.alt?.trim();
  return new ImageRun({
    type: loaded.type,
    data: loaded.data,
    transformation: { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) },
    ...(alt ? { altText: { name: alt.slice(0, 120), description: alt, title: alt.slice(0, 120) } } : {}),
  });
}

async function loadPicture(
  src: string,
  ctx: Ctx,
): Promise<{ type: "jpg" | "png" | "gif" | "bmp"; data: Buffer; width: number; height: number }> {
  const buf = await readPicture(src, ctx.baseDir);
  let actual = sniffImage(buf);
  let bytes = buf;
  if (actual === "webp" || actual === "svg") {
    ctx.seq.n += 1;
    const ext = actual === "svg" ? ".svg" : ".webp";
    const srcPath = path.join(ctx.scratch, `src-${ctx.seq.n}${ext}`);
    const dest = path.join(ctx.scratch, `out-${ctx.seq.n}.png`);
    fs.writeFileSync(srcPath, buf);
    const written = await convertImage(srcPath, dest, "png");
    if (!written) throw new Error(`picture ${path.basename(src)} could not be packed into the Word file`);
    bytes = fs.readFileSync(written);
    actual = "png";
  }
  const type = wordType(actual);
  if (!type) throw new Error(`picture ${src.startsWith("data:") ? "inline picture" : path.basename(src)} is not a format a Word file can hold`);
  const size = await imageSize(bytes);
  return { type, data: bytes, width: size.width, height: size.height };
}

async function readPicture(src: string, baseDir: string): Promise<Buffer> {
  if (src.startsWith("data:")) {
    const match = /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)$/i.exec(src);
    if (!match) throw new Error("picture data URI could not be read");
    return Buffer.from(match[1]!.replace(/\s/g, ""), "base64");
  }
  const clean = src.split("?")[0]?.split("#")[0] ?? src;
  let rel = clean;
  try {
    rel = decodeURIComponent(clean);
  } catch {
    rel = clean;
  }
  const fileUrl = /^file:\/\//i.test(rel) ? rel.replace(/^file:\/\//i, "") : "";
  const abs = fileUrl ? path.normalize(fileUrl) : path.resolve(baseDir, rel);
  if (!fs.existsSync(abs)) throw new Error(`picture ${path.basename(rel)} was not found`);
  return fs.readFileSync(abs);
}

function wordType(format: ImageFormat | null): "jpg" | "png" | "gif" | "bmp" | null {
  if (format === "jpeg") return "jpg";
  if (format === "png" || format === "gif") return format;
  return null;
}

async function imageSize(buf: Buffer): Promise<{ width: number; height: number }> {
  const sharp = (await import("sharp")).default;
  const meta = await sharp(buf, { limitInputPixels: false }).metadata();
  return { width: meta.width ?? 0, height: meta.height ?? 0 };
}

function imgPixels(el: El): { w?: number; h?: number } {
  const style = styleMap(el.attrs.style);
  return {
    w: cssPx(style.width) ?? attrPx(el.attrs.width),
    h: cssPx(style.height) ?? attrPx(el.attrs.height),
  };
}

function childCtx(el: El, parent: Ctx): Ctx {
  const style = styleMap(el.attrs.style);
  const marks: Marks = { ...parent.marks };
  const weight = style["font-weight"];
  if (el.tag === "b" || el.tag === "strong" || el.tag === "th" || weight === "bold" || weight === "bolder" || Number(weight) >= 600) {
    marks.bold = true;
  }
  if (el.tag === "i" || el.tag === "em" || style["font-style"] === "italic") marks.italics = true;
  const deco = style["text-decoration"] ?? "";
  if (el.tag === "u" || deco.includes("underline")) marks.underline = true;
  if (el.tag === "s" || el.tag === "strike" || el.tag === "del" || deco.includes("line-through")) marks.strike = true;
  if (el.tag === "sup") marks.superScript = true;
  if (el.tag === "sub") marks.subScript = true;
  const color = cssColor(style.color);
  if (color) marks.color = color;
  const size = cssSize(style["font-size"]);
  if (size) marks.size = size;
  const font = cssFont(style["font-family"]);
  if (font) marks.font = font;
  const align = cssAlign(style["text-align"]) ?? parent.align;
  return { ...parent, marks, align, breakBefore: false, pre: parent.pre || el.tag === "pre" };
}

/** The first block of an element owns a page break asked for on that element or its parent. */
function takeBreak(parent: Ctx, el: El): boolean {
  const style = styleMap(el.attrs.style);
  const own = /^(always|page)$/.test((style["page-break-before"] ?? style["break-before"] ?? "").trim());
  const value = own || parent.breakBefore;
  parent.breakBefore = false;
  return value;
}

function consumeBreak(ctx: Ctx): boolean {
  const value = ctx.breakBefore;
  ctx.breakBefore = false;
  return value;
}

function styleMap(style: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!style) return out;
  for (const part of style.split(";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    out[part.slice(0, colon).trim().toLowerCase()] = part.slice(colon + 1).trim().toLowerCase();
  }
  return out;
}

function cssAlign(value: string | undefined): Align | undefined {
  if (value === "center") return AlignmentType.CENTER;
  if (value === "right" || value === "end") return AlignmentType.RIGHT;
  if (value === "justify") return AlignmentType.BOTH;
  if (value === "left" || value === "start") return AlignmentType.LEFT;
  return undefined;
}

function cssColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const raw = hex[1]!;
    return (raw.length === 3 ? raw.replace(/./g, (c) => c + c) : raw).toUpperCase();
  }
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i.exec(value);
  if (!rgb) return undefined;
  return [rgb[1], rgb[2], rgb[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join("").toUpperCase();
}

function cssSize(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^([\d.]+)(px|pt)$/.exec(value.trim());
  if (!match) return undefined;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(match[2] === "pt" ? n * 2 : n * 1.5);
}

function cssFont(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const generic = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "inherit"]);
  const first = value.split(",")[0]?.trim().replace(/^['"]|['"]$/g, "");
  if (!first || generic.has(first)) return undefined;
  return first;
}

function cssPx(value: string | undefined): number | undefined {
  if (!value || value === "auto") return undefined;
  const match = /^([\d.]+)(px|pt|in|%)?$/.exec(value.trim());
  if (!match) return undefined;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const unit = match[2] ?? "px";
  if (unit === "%") return Math.round((COLUMN_PX * n) / 100);
  if (unit === "in") return Math.round(n * 96);
  if (unit === "pt") return Math.round((n * 96) / 72);
  return Math.round(n);
}

function attrPx(value: string | undefined): number | undefined {
  return cssPx(value);
}

function trimmed(nodes: HtmlNode[]): HtmlNode[] {
  const copy = nodes.map((node) => (node.kind === "text" ? { ...node } : node));
  let start = 0;
  let end = copy.length - 1;
  while (start <= end) {
    const node = copy[start];
    if (!node || node.kind !== "text" || node.text.trim()) break;
    start++;
  }
  while (end >= start) {
    const node = copy[end];
    if (!node || node.kind !== "text" || node.text.trim()) break;
    end--;
  }
  const slice = copy.slice(start, end + 1);
  const first = slice[0];
  if (first?.kind === "text") slice[0] = { kind: "text", text: first.text.replace(/^\s+/, "") };
  const last = slice[slice.length - 1];
  if (last?.kind === "text" && last !== slice[0]) slice[slice.length - 1] = { kind: "text", text: last.text.replace(/\s+$/, "") };
  else if (last?.kind === "text") slice[slice.length - 1] = { kind: "text", text: last.text.replace(/^\s+/, "").replace(/\s+$/, "") };
  return slice.filter((node) => node.kind === "el" || node.text.length > 0);
}

function collectText(el: El): string {
  let text = "";
  for (const child of el.children) {
    if (child.kind === "text") text += child.text;
    else if (child.tag === "br") text += "\n";
    else text += collectText(child);
  }
  return text;
}

function positive(value: string | undefined): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n > 1 ? n : undefined;
}
