import PDFDocument from 'pdfkit';
import path from 'node:path';
export function buildBillingPdf(title: string, project: string, currency: string, customer: string, lines: string[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: title, Author: project } });
        doc.registerFont('Billing', path.resolve(process.cwd(), 'assets/fonts/NotoSansBengali.ttf'));
        const chunks: Buffer[] = [];
        doc.on('data', chunk => chunks.push(Buffer.from(chunk)));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        const heading = () => { doc.font('Billing').fontSize(18).fillColor('#06294F').text(title); doc.fontSize(11).text(project); doc.font('Billing').fontSize(10).fillColor('#14233A').text(`Customer: ${customer}`).text(`Currency: ${currency}`).moveDown(); };
        doc.on('pageAdded', heading);
        heading();
        for (const line of lines) {
            const height = doc.heightOfString(line, { width: 499 }) + 8;
            if (doc.y + height + 20 > doc.page.height - 48) {
                doc.addPage();
            }
            doc.text(line, { width: 499 }).moveDown(0.4);
        }
        doc.end();
    });
}
