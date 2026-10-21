import PDFDocument from 'pdfkit';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { DocumentPresentation } from './document-settings.js';

type Line = { description: string; quantity: number; unit_price: number; line_total?: number; unit?: string; item_code?: string; model?: string; brand?: string; country?: string };
export interface PrintableDocument {
  kind: string; number: string; status: string; revision?: number; documentDate: Date | string; dueDate?: Date | string | null;
  customerSnapshot: unknown; quotationPersonSnapshot?: unknown; presentationSnapshot?: unknown;
  lines: unknown; subtotal: number; discount: number; tax: number; total: number; note?: string | null; taxSnapshot?: unknown;
}
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const palette = { ink: '#17324D', blue: '#08518B', muted: '#5B6877', pale: '#EDF2F6', rule: '#D6DFE6' };
export type InlineRun = { text: string; bold?: boolean; italic?: boolean; link?: string };
/** A small, non-HTML format: paragraphs, blank lines, numbered lists, emphasis and safe links. */
export function inlineRuns(text: string): InlineRun[] {
  const runs: InlineRun[] = [], re = /(\*\*\*[^*\n]+\*\*\*|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>]+)/g;
  let from = 0;
  for (const match of text.matchAll(re)) {
    const at = match.index!; if (at > from) runs.push({ text: text.slice(from, at) });
    const token = match[0], link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(token);
    runs.push(link ? { text: link[1], link: link[2] } : token.startsWith('http') ? { text: token, link: token } : token.startsWith('***') ? { text: token.slice(3, -3), bold: true, italic: true } : token.startsWith('**') ? { text: token.slice(2, -2), bold: true } : { text: token.slice(1, -1), italic: true });
    from = at + token.length;
  }
  if (from < text.length) runs.push({ text: text.slice(from) });
  return runs;
}
const font = (run: InlineRun) => run.bold && run.italic ? 'SansBI' : run.bold ? 'SansB' : run.italic ? 'SansI' : 'Sans';
const day = (value: Date | string) => new Date(value).toISOString().slice(0, 10);
const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** PDF and on-device preview use the same page coordinates and wrapping decisions. */
export async function buildProfessionalDocument(d: PrintableDocument, currency: string, fallback: string) {
  const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false, bufferPages: true, info: { Title: `${d.kind === 'quotation' ? 'Quotation' : d.kind === 'order' ? 'Sales order' : 'Sales invoice'} ${d.number}`, Author: fallback } });
  const chunks: Buffer[] = [], finished = new Promise<Buffer>((resolve, reject) => { doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  const faces = { Sans: 'Regular', SansB: 'Bold', SansI: 'Italic', SansBI: 'BoldItalic' };
  const fontBuffers = Object.fromEntries(Object.entries(faces).map(([name, file]) => [name, readFileSync(path.resolve(process.cwd(), `assets/fonts/LiberationSans-${file}.ttf`))]));
  for (const [name, bytes] of Object.entries(fontBuffers)) doc.registerFont(name, bytes);
  const p = d.presentationSnapshot as DocumentPresentation | null;
  const profile = p?.profile ?? { name: fallback, address: '', phone: '', email: '', website: '', footer: '', preparedBy: '', designation: '' };
  const bangla = /[\u0980-\u09FF]/.test(JSON.stringify(d)), noto = bangla ? readFileSync(path.resolve(process.cwd(), 'assets/fonts/NotoSansBengali.ttf')) : null;
  if (noto) doc.registerFont('Noto', noto);
  const pages: string[][] = []; let commands: string[] = [], y = 0;
  const W = 595.28, H = 841.89, L = 42, R = W - L, B = 744;
  function text(value: string, x: number, top: number, size = 9, run: InlineRun = { text: '' }, color = palette.ink) {
    const f = noto && /[\u0980-\u09FF]/.test(value) ? 'Noto' : font(run);
    doc.font(f).fontSize(size).fillColor(color).text(value, x, top, { lineBreak: false, ...(run.link ? { link: run.link, underline: true } : {}) });
    const element = `<text x="${x}" y="${top + size * .8}" font-family="${f}" font-size="${size}" font-weight="${run.bold ? 700 : 400}" font-style="${run.italic ? 'italic' : 'normal'}" fill="${color}"${run.link ? ' text-decoration="underline"' : ''} xml:space="preserve">${esc(value)}</text>`;
    commands.push(run.link ? `<a href="${esc(run.link)}" target="_blank" rel="noreferrer">${element}</a>` : element);
  }
  function width(value: string, size = 9, run: InlineRun = { text: '' }) { return doc.font(noto && /[\u0980-\u09FF]/.test(value) ? 'Noto' : font(run)).fontSize(size).widthOfString(value); }
  function rect(x: number, top: number, w: number, h: number, fill: string) { doc.rect(x, top, w, h).fill(fill); commands.push(`<rect x="${x}" y="${top}" width="${w}" height="${h}" fill="${fill}"/>`); }
  function rule(top: number) { rect(L, top, R - L, .6, palette.rule); }
  function wrap(runs: InlineRun[], max: number, size: number) {
    const lines: InlineRun[][] = [[]]; let used = 0;
    for (const run of runs) for (const token of run.text.split(/(\s+)/).filter(Boolean)) {
      if (width(token, size, run) > max) {
        for (const c of token) { const w = width(c, size, run); if (used + w > max && used) { lines.push([]); used = 0; } lines.at(-1)!.push({ ...run, text: c }); used += w; }
      } else {
        const w = width(token, size, run); if (used + w > max && used) { lines.push([]); used = 0; }
        lines.at(-1)!.push({ ...run, text: token }); used += w;
      }
    }
    return lines;
  }
  function drawRuns(runs: InlineRun[], x: number, top: number, size: number) { for (const run of runs) { text(run.text, x, top, size, run, run.link ? palette.blue : palette.ink); x += width(run.text, size, run); } }
  function newPage() {
    doc.addPage(); commands = []; pages.push(commands);
    let at = 30;
    for (const nameLine of wrap([{ text: profile.name, bold: true }], R - L, 16)) { text(nameLine.map(run => run.text).join(''), L, at, 16, { text: '', bold: true }, palette.blue); at += 21; }
    at += 3;
    for (const raw of [profile.address, [profile.phone, profile.email, profile.website].filter(Boolean).join(' | ')].filter(Boolean)) for (const line of wrap(inlineRuns(raw), R - L, 8)) { drawRuns(line, L, at, 8); at += 11; }
    rule(at + 4); y = at + 18;
  }
  function ensure(h: number) { if (y + h > B) newPage(); }
  function section(title: string) { ensure(40); rect(L, y, R - L, 19, palette.pale); text(title, L + 7, y + 5, 9, { text: '', bold: true }); y += 27; }
  function rich(raw: string, size = 9) {
    for (const paragraph of raw.replace(/\r\n?/g, '\n').split('\n')) {
      if (!paragraph) { ensure(9); y += 9; continue; }
      for (const line of wrap(inlineRuns(paragraph), R - L - 12, size)) { ensure(size * 1.5); drawRuns(line, L + 6, y, size); y += size * 1.5; }
    }
    y += 7;
  }
  function paragraphSection(title: string, raw: string) {
    const height = raw.replace(/\r\n?/g, '\n').split('\n').reduce((sum, paragraph) => sum + (paragraph ? wrap(inlineRuns(paragraph), R - L - 12, 9).length * 13.5 : 9), 34);
    // Keep short sections together; reserve several lines before splitting long ones.
    ensure(Math.min(160, height)); section(title); rich(raw);
  }
  function info(left: [string, unknown][], right: [string, unknown][]) {
    const gap = 22, cw = (R - L - gap) / 2;
    for (let row = 0; row < Math.max(left.length, right.length); row++) {
      const cells = [left[row], right[row]].map(value => value ? wrap([{ text: value[0] + ': ', bold: true }, { text: String(value[1] || '-') }], cw - 10, 8.5) : []);
      const height = Math.max(...cells.map(lines => lines.length), 1) * 13 + 3;
      ensure(height);
      cells.forEach((lines, column) => lines.forEach((line, n) => drawRuns(line, L + column * (cw + gap) + 5, y + n * 13, 8.5)));
      y += height;
    }
    y += 7;
  }
  newPage();
  text(d.kind === 'quotation' ? 'SALES QUOTATION' : d.kind === 'order' ? 'SALES ORDER' : 'SALES INVOICE', L, y, 16, { text: '', bold: true });
  text(`${d.status.toUpperCase()}${d.revision ? ` | Revision ${d.revision}` : ''}`, R - 140, y + 4, 8, { text: '' }, palette.muted); y += 29;
  const customer = d.customerSnapshot as { name: string; mobile?: string; address?: string; email?: string };
  const person = d.quotationPersonSnapshot as { name?: string; email?: string; mobile?: string; designation?: string } | null;
  section('Customer and document information');
  info([['Quote to', person?.name || customer.name], ['Designation', person?.designation], ['Email', person?.email || customer.email], ['Phone', person?.mobile || customer.mobile]], [['Document no.', d.number], ['Document date', day(d.documentDate)], ['Valid / due until', d.dueDate ? day(d.dueDate) : '-'], ['Prepared by', p?.preparedByName || profile.preparedBy]]);
  section('Billing and delivery details');
  info([['Bill to', customer.name], ['Address', customer.address]], [['Ship to', customer.name], ['Address', customer.address]]);
  const columns = [L, L + 22, L + 79, L + 143, L + 305, L + 333, L + 362, L + 432, R];
  function tableHead() {
    ensure(40); rect(L, y, R - L, 30, palette.blue);
    ['No.', 'Item code', 'Model', 'Description', 'UOM', 'Qty', `Unit price (${currency})`, `Total (${currency})`].forEach((v, i) => { const lines = wrap([{ text: v, bold: true }], columns[i + 1] - columns[i] - 8, 7.5); for (const [n, line] of lines.entries()) text(line.map(r => r.text).join(''), columns[i] + 4, y + 6 + n * 9, 7.5, { text: '', bold: true }, '#FFFFFF'); }); y += 30;
  }
  tableHead();
  for (const [index, line] of (d.lines as Line[]).entries()) {
    const description = [line.description, [line.brand, line.country ? `Origin: ${line.country}` : ''].filter(Boolean).join(' | ')].filter(Boolean).join('\n');
    const cells = [String(index + 1), line.item_code || '-', line.model || '-', description, line.unit || 'pcs', String(line.quantity), money(line.unit_price), money(line.line_total ?? Math.round(line.quantity * line.unit_price))];
    const wrapped = cells.map((value, i) => value.split('\n').flatMap(v => wrap([{ text: v }], columns[i + 1] - columns[i] - 8, 8)));
    let offset = 0, count = Math.max(...wrapped.map(v => v.length));
    while (offset < count) {
      if (y + 24 > B) { newPage(); tableHead(); }
      const take = Math.min(count - offset, Math.floor((B - y - 10) / 11));
      if (take <= 0) { newPage(); tableHead(); continue; }
      const h = Math.max(24, take * 11 + 10); if (index % 2 === 1) rect(L, y, R - L, h, '#F4F6F8');
      wrapped.forEach((rows, i) => rows.slice(offset, offset + take).forEach((runs, n) => drawRuns(runs, columns[i] + 4, y + 5 + n * 11, 8)));
      y += h; rule(y); offset += take;
    }
  }
  y += 13;
  const tax = d.taxSnapshot as { version?: number; breakdown?: { name: string; amount: number; kind: string }[]; inclusive?: boolean; withholding?: number } | null;
  const totals: [string, number][] = [['Subtotal', d.subtotal], ...(d.discount ? [['Discount', -d.discount] as [string, number]] : []), ...(tax?.version === 1 ? (tax.breakdown ?? []).map(r => [r.name + (r.kind === 'withhold' ? ' (withheld)' : tax.inclusive ? ' (included)' : ''), r.kind === 'withhold' ? -r.amount : r.amount] as [string, number]) : d.tax ? [['Tax', d.tax] as [string, number]] : []), ['Grand total', d.total]];
  ensure(totals.length * 19 + 12);
  for (const [i, [label, amount]] of totals.entries()) {
    const bold = i === totals.length - 1, value = `${currency} ${money(amount)}`;
    const amountX = R - width(value, 10, { text: '', bold }) - 5;
    const labels = wrap([{ text: label, bold }], amountX - (L + 287) - 12, 9), height = Math.max(22, labels.length * 12 + 8);
    ensure(height);
    if (bold) rect(L + 280, y - 3, R - L - 280, height + 1, palette.pale);
    labels.forEach((line, n) => drawRuns(line, L + 287, y + 2 + n * 12, 9));
    text(value, amountX, y + 2, 10, { text: '', bold }); y += height;
  }
  y += 10;
  if (d.note) paragraphSection('Note', d.note);
  if (p?.terms.enabled && p.terms.text) paragraphSection('Terms and Conditions', p.terms.text);
  if (p?.disclaimer.enabled && p.disclaimer.text) paragraphSection('DISCLAIMER', p.disclaimer.text);
  if (p?.preparedByName || profile.designation) { const names = wrap([{ text: p?.preparedByName || profile.preparedBy, bold: true }], R - L - 12, 9), roles = wrap([{ text: profile.designation }], R - L - 12, 8); ensure(20 + names.length * 14 + roles.length * 12); y += 16; for (const line of names) { drawRuns(line, L + 6, y, 9); y += 14; } for (const line of roles) { drawRuns(line, L + 6, y, 8); y += 12; } }
  const range = doc.bufferedPageRange();
  for (let n = 0; n < range.count; n++) { doc.switchToPage(n); commands = pages[n]; rule(765); const footerLines = wrap([{ text: profile.footer || profile.name }], R - L - 40, 7.5); footerLines.forEach((line, i) => text(line.map(r => r.text).join(''), L, 775 + i * 9, 7.5, { text: '' }, palette.muted)); text(`${n + 1} / ${range.count}`, R - 25, 805, 8, { text: '' }, palette.muted); }
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#DCE3E9;padding:8px}svg{display:block;width:100%;height:auto;max-width:795px;margin:0 auto 12px;background:white;box-shadow:0 2px 8px #0002}${Object.entries(fontBuffers).map(([name, bytes]) => `@font-face{font-family:${name};font-weight:${name.includes('B') ? 700 : 400};font-style:${name.includes('I') ? 'italic' : 'normal'};src:url(data:font/ttf;base64,${bytes.toString('base64')})}`).join('')}${noto ? `@font-face{font-family:Noto;src:url(data:font/ttf;base64,${noto.toString('base64')})}` : ''}</style></head><body>${pages.map(page => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${page.join('')}</svg>`).join('')}</body></html>`;
  doc.end(); return { pdf: await finished, html, pages: pages.length };
}
