import path from 'node:path';
import XLSX from 'xlsx';
import PDFDocument from 'pdfkit';
import { overview, type Scope } from './fixed-assets.service.js';
export async function exportAssets(a: Scope, format: 'xlsx' | 'pdf') {
    const data = await overview(a), rows = data.assets.map(r => ({ Code: r.code, Name: r.name, Category: r.category, Status: r.status, Location: r.location, 'Assigned to': r.assignedTo, Serial: r.serial, 'Purchase date': r.purchaseDate.toISOString().slice(0, 10), 'Cost': r.cost, 'Accumulated depreciation': r.accumulated, 'Book value': r.book_value, 'Residual': r.residual, 'Life (months)': r.lifeMonths }));
    if (format === 'xlsx') {
        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), 'Asset register');
        XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(data.monthly.map(m => ({ Month: m.month, Depreciation: m.amount, Status: m.forecast ? 'Forecast' : 'Posted' }))), 'Monthly depreciation');
        XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(data.categories.map(c => ({ Category: c.name, Assets: c.count, 'Book value': c.book_value, 'Monthly forecast': c.forecast, 'FYTD depreciation': c.fytd }))), 'Category summary');
        return { filename: `fixed-assets-${data.through}.xlsx`, base64: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }).toString('base64'), mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    }
    const doc = new PDFDocument({ margin: 40, size: 'A4' }), chunks: Buffer[] = [];
    doc.registerFont('Assets', path.resolve(process.cwd(), 'assets/fonts/NotoSansBengali.ttf'));
    doc.font('Assets');
    const done = new Promise<Buffer>((resolve, reject) => { doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
    doc.fontSize(21).text('Fixed asset register').moveDown(.5).fontSize(10).text(`Values through ${data.through} | Currency: project base units`).moveDown();
    doc.text(`Active assets: ${data.count} | Cost: ${data.cost} | Depreciation: ${data.accumulated} | Book value: ${data.book_value}`).moveDown();
    for (const row of data.assets) {
        if (doc.y > 700)
            doc.addPage();
        doc.fontSize(12).text(`${row.code} | ${row.name}`).fontSize(10).text(`${row.category} | ${row.status} | ${row.location}`).text(`Cost ${row.cost} | Depreciation ${row.accumulated} | Book value ${row.book_value}`).moveDown();
    }
    doc.addPage().fontSize(18).text('Monthly depreciation').moveDown().fontSize(11);
    data.monthly.forEach(m => doc.text(`${m.month}: ${m.amount} ${m.forecast ? '(Forecast)' : '(Posted)'}`).moveDown(.3));
    doc.end();
    return { filename: `fixed-assets-${data.through}.pdf`, base64: (await done).toString('base64'), mime_type: 'application/pdf' };
}
