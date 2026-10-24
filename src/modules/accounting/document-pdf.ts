import { selectedItemDetails, type ItemDetailValue } from './item-detail-fields.js';
import PDFDocument from 'pdfkit';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { DocumentPresentation } from './document-settings.js';

type Line = { item_details?: ItemDetailValue[]; description: string; quantity: number; unit_price: number; line_total?: number; unit?: string; item_code?: string; model?: string; brand?: string; country?: string };
export interface PrintableDocument {
  kind: string; number: string; status: string; revision?: number; documentDate: Date | string; dueDate?: Date | string | null;
  customerSnapshot: unknown; quotationPersonSnapshot?: unknown; presentationSnapshot?: unknown;
  additionalCharges?: unknown;
  lines: unknown; subtotal: number; discount: number; tax: number; total: number; note?: string | null; taxSnapshot?: unknown;
}
const hasValue = (value: unknown) => value !== null && value !== undefined && String(value).trim().length > 0;
const shown = (value: unknown) => hasValue(value) ? String(value) : '';
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const basePalette = { ink: '#17324D', blue: '#08518B', muted: '#5B6877', pale: '#EDF2F6', rule: '#D6DFE6' };
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
export async function buildProfessionalDocument(d: PrintableDocument, currency: string, fallback: string, logo?: { buffer: Buffer; mime: string } | null) {
  const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false, bufferPages: true, info: { Title: `${d.kind === 'quotation' ? 'Quotation' : d.kind === 'order' ? 'Sales order' : 'Sales invoice'} ${d.number}`, Author: fallback } });
  const chunks: Buffer[] = [], finished = new Promise<Buffer>((resolve, reject) => { doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  const faces = { Sans: 'Regular', SansB: 'Bold', SansI: 'Italic', SansBI: 'BoldItalic' };
  const fontBuffers = Object.fromEntries(Object.entries(faces).map(([name, file]) => [name, readFileSync(path.resolve(process.cwd(), `assets/fonts/LiberationSans-${file}.ttf`))]));
  for (const [name, bytes] of Object.entries(fontBuffers)) doc.registerFont(name, bytes);
  const p = d.presentationSnapshot as DocumentPresentation | null;
  const layouts = { classic: { accent: '#08518B', pale: '#EDF2F6' }, executive: { accent: '#08776E', pale: '#EAF5F1' }, minimal: { accent: '#334155', pale: '#F5F7F8' }, corporate: { accent: '#153B65', pale: '#EDF2F8' }, elegant: { accent: '#7E344A', pale: '#F7EFF0' } };
  const layout = p?.templateId && p.templateId in layouts ? p.templateId : 'classic';
  const accent = p?.accentColor && /^#[0-9a-f]{6}$/i.test(p.accentColor) ? p.accentColor : layouts[layout].accent;
  const palette = { ...basePalette, blue: accent, pale: p?.accentColor ? '#' + [1, 3, 5].map(at => Math.round(parseInt(accent.slice(at, at + 2), 16) * .08 + 255 * .92).toString(16).padStart(2, '0')).join('') : layouts[layout].pale };
  const luminance = [1, 3, 5].map(at => parseInt(accent.slice(at, at + 2), 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
  const onAccent = luminance <= .179 ? '#FFFFFF' : '#000000';
  if (luminance > .179) palette.blue = '#' + [1, 3, 5].map(at => Math.round(parseInt(accent.slice(at, at + 2), 16) * .4).toString(16).padStart(2, '0')).join('');
  const legacyProfile = p?.profile as unknown as { preparedBy?: string; designation?: string } | null;
  const author = p?.preparedBy ?? { id: '', name: p?.preparedByName || legacyProfile?.preparedBy || '', designation: legacyProfile?.designation || '', mobile: '', email: '' };
  let imageSize: { width: number; height: number } | null = null;
  if (logo) try { imageSize = (doc as unknown as { openImage: (source: Buffer) => { width: number; height: number } }).openImage(logo.buffer); } catch { logo = null; }

  const profile = p?.profile ?? { name: fallback, address: '', phone: '', email: '', website: '', footer: '',  };
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
  function drawRuns(runs: InlineRun[], x: number, top: number, size: number, ink?: string) { for (const run of runs) { text(run.text, x, top, size, run, ink ?? (run.link ? palette.blue : palette.ink)); x += width(run.text, size, run); } }
  function drawLogo(x: number, top: number, w: number, h: number) {
    if (!logo || !imageSize) return;
    const ratio = Math.min(w / imageSize.width, h / imageSize.height), iw = imageSize.width * ratio, ih = imageSize.height * ratio;
    const px = x + (w - iw) / 2, py = top + (h - ih) / 2;
    doc.image(logo.buffer, px, py, { width: iw, height: ih });
    commands.push(`<image x="${px}" y="${py}" width="${iw}" height="${ih}" href="data:${logo.mime};base64,${logo.buffer.toString('base64')}"/>`);
  }
  function newPage() {
    doc.addPage(); commands = []; pages.push(commands);
    const logoWidth = logo ? 82 : 0, minimal = layout === 'minimal';
    const nameX = minimal && logo ? L + 76 : L, nameSize = layout === 'elegant' ? 18 : minimal ? 14 : 16;
    const nameLines = wrap([{ text: profile.name, bold: true }], R - L - logoWidth, nameSize);
    const contactLines = [profile.address, [profile.phone, profile.email, profile.website].filter(hasValue).join(' | ')].filter(hasValue).flatMap(raw => wrap(inlineRuns(raw), R - L - logoWidth, 8));
    const height = Math.max(72, nameLines.length * 22 + contactLines.length * 11 + 25);
    if (layout === 'corporate') rect(0, 0, W, height + 20, accent);
    if (layout === 'executive') rect(L - 12, 30, 4, height - 10, accent);
    if (logo) { if (layout === 'corporate') rect(R - 77, 27, 77, 57, '#FFFFFF'); drawLogo(minimal ? L : R - 73, 30, 70, 51); }
    const ink = layout === 'corporate' ? onAccent : undefined;
    let at = 30;
    for (const line of nameLines) { text(line.map(run => run.text).join(''), nameX, at, nameSize, { text: '', bold: true }, ink ?? palette.blue); at += 22; }
    at += 3;
    for (const line of contactLines) { drawRuns(line, nameX, at, 8, ink); at += 11; }
    const bottom = Math.max(at, 30 + (logo ? 51 : 0));
    if (layout === 'corporate') y = Math.max(bottom + 22, height + 34);
    else { if (layout === 'minimal') rect(L, bottom + 5, R - L, .8, accent); else rule(bottom + 5); if (layout === 'elegant') rect(L, bottom + 8, R - L, 1.5, accent); y = bottom + 21; }
  }
  function ensure(h: number) { if (y + h > B) newPage(); }
  function section(title: string) { ensure(40); if (layout === 'minimal') { rule(y + 21); } else { rect(L, y, R - L, 19, palette.pale); if (layout === 'executive') rect(L, y, 3, 19, accent); } text(title, L + 7, y + 5, 9, { text: '', bold: true }); y += 27; }
  function rich(raw: string, size = 9) {
    for (const paragraph of raw.replace(/\r\n?/g, '\n').split('\n')) {
      if (!paragraph) { ensure(9); y += 9; continue; }
      for (const line of wrap(inlineRuns(paragraph), R - L - 12, size)) { ensure(size * 1.5); drawRuns(line, L + 6, y, size); y += size * 1.5; }
    }
    y += 7;
  }
  function paragraphSection(title: string, raw: string, keepAfter = 0) {
    const height = raw.replace(/\r\n?/g, '\n').split('\n').reduce((sum, paragraph) => sum + (paragraph ? wrap(inlineRuns(paragraph), R - L - 12, 9).length * 13.5 : 9), 34);
    // Keep short sections together; reserve several lines before splitting long ones.
    ensure(Math.min(160, height + keepAfter)); section(title); rich(raw);
  }
  function info(left: [string, unknown][], right: [string, unknown][]) {
    left = left.filter(([, value]) => hasValue(value)); right = right.filter(([, value]) => hasValue(value));
    const gap = 22, cw = (R - L - gap) / 2;
    for (let row = 0; row < Math.max(left.length, right.length); row++) {
      const cells = [left[row], right[row]].map(value => value ? wrap([{ text: value[0] + ': ', bold: true }, { text: String(value[1]) }], cw - 10, 8.5) : []);
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
  info([['Quote to', person?.name || customer.name], ['Designation', person?.designation], ['Email', person?.email || customer.email], ['Phone', person?.mobile || customer.mobile]], [['Document no.', d.number], ['Document date', day(d.documentDate)], ['Valid / due until', d.dueDate ? day(d.dueDate) : null], ['Prepared by', author.name]]);
  section('Billing and delivery details');
  info([['Bill to', customer.name], ['Address', customer.address]], [['Ship to', customer.name], ['Address', customer.address]]);
  const documentLines = d.lines as Line[];
  const configured = p?.itemDetails != null;
  const activeColumns = configured ? [0, 3, 5, 6, 7] : [0, ...(documentLines.some(l => hasValue(l.item_code)) ? [1] : []), ...(documentLines.some(l => hasValue(l.model)) ? [2] : []), 3, ...(documentLines.some(l => hasValue(l.unit)) ? [4] : []), 5, 6, 7];
  const widths = [22, 57, 64, 162, 28, 29, 70, R - L - 432], columns = [L];
  const recovered = widths.reduce((sum, width, i) => sum + (activeColumns.includes(i) ? 0 : width), 0);
  for (const i of activeColumns) columns.push(columns.at(-1)! + widths[i] + (i === 3 ? recovered : 0));
  function tableHead() {
    ensure(40); rect(L, y, R - L, 30, layout === 'minimal' ? '#FFFFFF' : layout === 'elegant' ? palette.pale : accent);
    activeColumns.map(i => ['No.', 'Item code', 'Model', 'Description', 'UOM', 'Qty', `Unit price (${currency})`, `Total (${currency})`][i]).forEach((v, i) => { const lines = wrap([{ text: v, bold: true }], columns[i + 1] - columns[i] - 8, 7.5); for (const [n, line] of lines.entries()) text(line.map(r => r.text).join(''), columns[i] + 4, y + 6 + n * 9, 7.5, { text: '', bold: true }, layout === 'minimal' || layout === 'elegant' ? palette.blue : onAccent); }); if (layout === 'minimal') rule(y + 29); y += 30;
  }
  tableHead();
  for (const [index, line] of documentLines.entries()) {
    const description = configured ? [line.description, ...selectedItemDetails(line, p?.itemDetails, d.kind, p?.includeItemDescription).map(v => `${v.label}: ${v.value}`)].join('\n') : [line.description, [shown(line.brand), hasValue(line.country) ? `Origin: ${line.country}` : ''].filter(hasValue).join(' | '), ...selectedItemDetails(line, null, d.kind, p?.includeItemDescription).map(v => `${v.label}: ${v.value}`)].filter(Boolean).join('\n');
    const cells = [String(index + 1), shown(line.item_code), shown(line.model), description, shown(line.unit), String(line.quantity), money(line.unit_price), money(line.line_total ?? Math.round(line.quantity * line.unit_price))];
    const wrapped = activeColumns.map(i => cells[i]).map((value, i) => value.split('\n').flatMap(v => wrap([{ text: v }], columns[i + 1] - columns[i] - 8, 8)));
    let offset = 0, count = Math.max(...wrapped.map(v => v.length));
    while (offset < count) {
      if (y + 24 > B) { newPage(); tableHead(); }
      const take = Math.min(count - offset, Math.floor((B - y - 10) / 11));
      if (take <= 0) { newPage(); tableHead(); continue; }
      const h = Math.max(24, take * 11 + 10); if (layout !== 'minimal' && index % 2 === 1) rect(L, y, R - L, h, '#F4F6F8');
      wrapped.forEach((rows, i) => rows.slice(offset, offset + take).forEach((runs, n) => drawRuns(runs, columns[i] + 4, y + 5 + n * 11, 8)));
      y += h; rule(y); offset += take;
    }
  }
  y += 13;
  const tax = d.taxSnapshot as { version?: number; breakdown?: { name: string; amount: number; kind: string }[]; inclusive?: boolean; withholding?: number } | null;
  const charges = (Array.isArray(d.additionalCharges) ? d.additionalCharges : []) as { label: string; amount: number; vat_treatment: string }[];
  const chargesTotal = charges.reduce((sum, charge) => sum + charge.amount, 0);
  const totals: [string, number][] = [[charges.length ? 'Items subtotal' : 'Subtotal', d.subtotal - chargesTotal], ...charges.map(charge => [`${charge.label} (${charge.vat_treatment === 'included' ? 'in VAT base' : 'outside VAT base'})`, charge.amount] as [string, number]), ...(d.discount ? [['Discount', -d.discount] as [string, number]] : []), ...(tax?.version === 1 ? (tax.breakdown ?? []).map(r => [r.name + (r.kind === 'withhold' ? ' (withheld)' : tax.inclusive && !charges.length ? ' (included)' : ''), r.kind === 'withhold' ? -r.amount : r.amount] as [string, number]) : d.tax ? [['Tax', d.tax] as [string, number]] : []), ['Grand total', d.total]];
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
  if (charges.length) paragraphSection('Charge treatment', 'Additional charges are before VAT and after the item discount. In VAT base uses the document VAT rate; outside VAT base adds no VAT.');
  if (hasValue(d.note)) paragraphSection('Note', d.note!);
  if (p?.terms.enabled && hasValue(p.terms.text)) paragraphSection('Terms and Conditions', p.terms.text);
  if (p?.disclaimer.enabled && hasValue(p.disclaimer.text)) paragraphSection('DISCLAIMER', p.disclaimer.text, hasValue(author.name) ? 80 : 0);
  if (hasValue(author.name)) {
    const signature = [author.name, author.designation, [author.mobile, author.email].filter(hasValue).join(' | ')].filter(hasValue);
    const lines = signature.flatMap((value, i) => wrap([{ text: value, bold: i === 0 }], R - L - 12, i === 0 ? 9 : 8).map(runs => ({ runs, size: i === 0 ? 9 : 8 })));
    ensure(24 + lines.length * 14); y += 16;
    for (const line of lines) { drawRuns(line.runs, L + 6, y, line.size); y += 14; }
  }
  const range = doc.bufferedPageRange();
  for (let n = 0; n < range.count; n++) { doc.switchToPage(n); commands = pages[n]; rule(765); const footerLines = wrap([{ text: hasValue(profile.footer) ? profile.footer : profile.name }], R - L - 40, 7.5); footerLines.forEach((line, i) => text(line.map(r => r.text).join(''), L, 775 + i * 9, 7.5, { text: '' }, palette.muted)); text(`${n + 1} / ${range.count}`, R - 25, 805, 8, { text: '' }, palette.muted); }
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#DCE3E9;padding:8px}svg{display:block;width:100%;height:auto;max-width:795px;margin:0 auto 12px;background:white;box-shadow:0 2px 8px #0002}${Object.entries(fontBuffers).map(([name, bytes]) => `@font-face{font-family:${name};font-weight:${name.includes('B') ? 700 : 400};font-style:${name.includes('I') ? 'italic' : 'normal'};src:url(data:font/ttf;base64,${bytes.toString('base64')})}`).join('')}${noto ? `@font-face{font-family:Noto;src:url(data:font/ttf;base64,${noto.toString('base64')})}` : ''}</style></head><body>${pages.map(page => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${page.join('')}</svg>`).join('')}</body></html>`;
  doc.end(); return { pdf: await finished, html, pages: pages.length };
}
