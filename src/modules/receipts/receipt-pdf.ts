function escapePdfText(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export function buildReceiptPdf(input: {
  receiptNo: string;
  amount: number;
  issuedAt: Date;
  memberName: string;
  memberMobile: string;
  projectName: string;
  projectAddress: string | null;
  method: string;
  reference: string | null;
  ownerMobile: string | null;
}) {
  const lines = [
    { size: 20, x: 54, y: 760, text: "PAYMENT RECEIPT" },
    { size: 11, x: 54, y: 730, text: input.projectName },
    { size: 11, x: 54, y: 707, text: input.projectAddress || "" },
    { size: 12, x: 54, y: 685, text: `Receipt: ${input.receiptNo}` },
    { size: 12, x: 54, y: 662, text: `Member: ${input.memberName}` },
    { size: 12, x: 54, y: 639, text: `Mobile: ${input.memberMobile}` },
    { size: 12, x: 54, y: 616, text: `Amount: BDT ${input.amount.toLocaleString("en-US")}` },
    { size: 12, x: 54, y: 593, text: `Method: ${input.method}` },
    { size: 12, x: 54, y: 570, text: `Date: ${input.issuedAt.toISOString().slice(0, 10)}` },
    ...(input.reference ? [{ size: 12, x: 54, y: 547, text: `Reference: ${input.reference}` }] : []),
    { size: 12, x: 54, y: 524, text: `Contact: ${input.ownerMobile || ""}` },
    { size: 10, x: 54, y: 500, text: "This receipt was generated after final payment approval." }
  ];
  const stream = lines
    .map((line) => `BT /F1 ${line.size} Tf ${line.x} ${line.y} Td (${escapePdfText(line.text)}) Tj ET`)
    .join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "ascii");
}
