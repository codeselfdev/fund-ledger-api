import PDFDocument from "pdfkit";
import { readFileSync } from "node:fs";
import path from "node:path";

const FALLBACK_APP_LOGO = loadFallbackAppLogo();

const COLORS = {
  navy: "#06294F",
  teal: "#0A7F78",
  tealDark: "#086761",
  tealTint: "#EAF7F4",
  gold: "#F4B942",
  ink: "#14233A",
  body: "#4E5B6D",
  muted: "#7B8797",
  line: "#E2E8EE",
  panel: "#F6F8FA",
  white: "#FFFFFF",
} as const;

export type ReceiptPdfInput = {
  receiptNo: string;
  amount: number;
  issuedAt: Date;
  memberName: string;
  memberMobile: string;
  memberAddress: string | null;
  projectName: string;
  projectAddress: string | null;
  projectLogo: Buffer | null;
  projectLogoMimeType: string | null;
  method: string;
  reference: string | null;
  ownerMobile: string | null;
  paymentPurpose: string;
};

export async function buildReceiptPdf(input: ReceiptPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 0,
      compress: true,
      info: {
        Title: `Payment Receipt ${input.receiptNo}`,
        Author: input.projectName,
        Subject: "Approved member payment receipt",
        Creator: "Fund Nesta",
      },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    drawReceipt(doc, input);
    doc.end();
  });
}

function drawReceipt(doc: PDFKit.PDFDocument, input: ReceiptPdfInput) {
  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const margin = 48;
  const contentWidth = pageWidth - margin * 2;

  doc.rect(0, 0, pageWidth, pageHeight).fill(COLORS.white);
  doc.rect(0, 0, pageWidth, 136).fill(COLORS.navy);
  doc.rect(0, 136, pageWidth, 6).fill(COLORS.gold);

  drawProjectIdentity(doc, input, margin);

  doc
    .font("Helvetica-Bold")
    .fontSize(19)
    .fillColor(COLORS.white)
    .text("PAYMENT RECEIPT", 330, 37, { width: pageWidth - margin - 330, align: "right" });
  doc
    .font("Helvetica")
    .fontSize(9.5)
    .fillColor("#C7D2DE")
    .text(input.receiptNo, 330, 66, { width: pageWidth - margin - 330, align: "right" });
  pill(doc, pageWidth - margin - 64, 91, 64, 24, "PAID", COLORS.teal, COLORS.white);

  doc
    .font("Helvetica")
    .fontSize(9.5)
    .fillColor(COLORS.muted)
    .text("Official acknowledgement of an approved member payment", margin, 162);

  const amountY = 187;
  doc.roundedRect(margin, amountY, contentWidth, 108, 8).fill(COLORS.navy);
  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor("#B8C8D7")
    .text("AMOUNT RECEIVED", margin + 24, amountY + 22);
  const amountText = formatAmount(input.amount);
  doc
    .font("Helvetica-Bold")
    .fontSize(fittingFontSize(doc, amountText, 315, 31, 20))
    .fillColor(COLORS.white)
    .text(amountText, margin + 24, amountY + 43, { width: 315, lineBreak: false });

  doc.roundedRect(pageWidth - margin - 138, amountY + 28, 114, 52, 7).fill(COLORS.tealDark);
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor("#BFE6DF")
    .text("APPROVED", pageWidth - margin - 126, amountY + 40, { width: 90, align: "center" });
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(COLORS.white)
    .text(formatDate(input.issuedAt), pageWidth - margin - 126, amountY + 57, { width: 90, align: "center" });

  sectionLabel(doc, "RECEIVED FROM", margin, 327);
  sectionLabel(doc, "PAYMENT DETAILS", 315, 327);

  doc.roundedRect(margin, 348, contentWidth, 124, 8).fillAndStroke(COLORS.panel, COLORS.line);
  doc.moveTo(297.5, 366).lineTo(297.5, 454).strokeColor(COLORS.line).lineWidth(1).stroke();

  valueBlock(doc, "MEMBER", input.memberName, margin + 20, 368, 215);
  valueBlock(doc, "MOBILE", input.memberMobile, margin + 20, 414, 215);
  if (input.memberAddress) {
    doc
      .font("Helvetica")
      .fontSize(8.5)
      .fillColor(COLORS.muted)
      .text(clean(input.memberAddress), margin + 20, 447, { width: 215, ellipsis: true, height: 16 });
  }

  valueBlock(doc, "PAYMENT METHOD", formatPaymentMethod(input.method), 315, 368, 212);
  valueBlock(doc, "REFERENCE", input.reference || "Not provided", 315, 414, 212);

  sectionLabel(doc, "PAYMENT SUMMARY", margin, 505);
  const tableY = 528;
  doc.roundedRect(margin, tableY, contentWidth, 34, 6).fill(COLORS.tealTint);
  tableText(doc, "DESCRIPTION", margin + 16, tableY + 12, 250, "left", true);
  tableText(doc, "METHOD", 337, tableY + 12, 88, "left", true);
  tableText(doc, "AMOUNT", 430, tableY + 12, 101, "right", true);

  doc.rect(margin, tableY + 34, contentWidth, 48).fillAndStroke(COLORS.white, COLORS.line);
  tableText(doc, input.paymentPurpose, margin + 16, tableY + 53, 250, "left", false);
  tableText(doc, formatPaymentMethod(input.method), 337, tableY + 53, 88, "left", false);
  tableText(doc, formatAmount(input.amount), 430, tableY + 53, 101, "right", false);

  const totalY = tableY + 96;
  doc.roundedRect(300, totalY, contentWidth - 252, 50, 7).fill(COLORS.gold);
  doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.navy).text("TOTAL PAID", 318, totalY + 20);
  doc
    .font("Helvetica-Bold")
    .fontSize(fittingFontSize(doc, amountText, 142, 15, 10))
    .fillColor(COLORS.navy)
    .text(amountText, 389, totalY + 18, { width: 142, align: "right", lineBreak: false });

  const noteY = 698;
  doc.roundedRect(margin, noteY, contentWidth, 58, 7).fill(COLORS.tealTint);
  doc.circle(margin + 24, noteY + 29, 10).fill(COLORS.teal);
  doc
    .moveTo(margin + 19, noteY + 29)
    .lineTo(margin + 23, noteY + 33)
    .lineTo(margin + 30, noteY + 24)
    .strokeColor(COLORS.white)
    .lineWidth(1.8)
    .stroke();
  doc
    .font("Helvetica-Bold")
    .fontSize(9.5)
    .fillColor(COLORS.tealDark)
    .text("PAYMENT VERIFIED", margin + 44, noteY + 15);
  doc
    .font("Helvetica")
    .fontSize(8.5)
    .fillColor(COLORS.body)
    .text("This receipt was generated after final approval and ledger posting.", margin + 44, noteY + 33);

  doc.moveTo(margin, pageHeight - 58).lineTo(pageWidth - margin, pageHeight - 58).strokeColor(COLORS.line).stroke();
  const contact = input.ownerMobile ? `Project contact: ${input.ownerMobile}` : "Generated securely by Fund Nesta";
  doc.font("Helvetica").fontSize(8).fillColor(COLORS.muted).text(contact, margin, pageHeight - 42, {
    width: contentWidth / 2,
  });
  doc.font("Helvetica").fontSize(8).fillColor(COLORS.muted).text("No signature required", pageWidth / 2, pageHeight - 42, {
    width: pageWidth / 2 - margin,
    align: "right",
  });
}

function drawProjectIdentity(doc: PDFKit.PDFDocument, input: ReceiptPdfInput, margin: number) {
  const logoSize = 62;
  doc.roundedRect(margin, 32, logoSize, logoSize, 8).fill(COLORS.white);

  // The logo tagged on the project always wins. The app mark is only a fallback.
  let logoDrawn = drawLogo(doc, input.projectLogo, margin, logoSize, "project");
  if (!logoDrawn) logoDrawn = drawLogo(doc, FALLBACK_APP_LOGO, margin, logoSize, "app fallback");

  if (!logoDrawn) {
    doc
      .font("Helvetica-Bold")
      .fontSize(18)
      .fillColor(COLORS.teal)
      .text(initials(input.projectName), margin, 52, { width: logoSize, align: "center" });
  }

  doc
    .font("Helvetica-Bold")
    .fontSize(fittingFontSize(doc, clean(input.projectName), 205, 17, 12))
    .fillColor(COLORS.white)
    .text(clean(input.projectName), margin + logoSize + 14, 40, {
      width: 205,
      height: 22,
      ellipsis: true,
      lineBreak: false,
    });
  if (input.projectAddress) {
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#C7D2DE")
      .text(clean(input.projectAddress), margin + logoSize + 14, 68, { width: 205, height: 26, ellipsis: true });
  } else {
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#C7D2DE")
      .text("Project payment account", margin + logoSize + 14, 66, { width: 205 });
  }
}

function drawLogo(
  doc: PDFKit.PDFDocument,
  logo: Buffer | null,
  margin: number,
  logoSize: number,
  source: string,
) {
  if (!logo) return false;
  try {
    doc.image(logo, margin + 6, 38, {
      fit: [logoSize - 12, logoSize - 12],
      align: "center",
      valign: "center",
    });
    return true;
  } catch (error) {
    console.error(`[receipt-pdf] failed to embed ${source} logo`, error);
    return false;
  }
}

function loadFallbackAppLogo() {
  try {
    return readFileSync(path.resolve(process.cwd(), "assets/fund-nesta-logo.png"));
  } catch (error) {
    console.error("[receipt-pdf] failed to load fallback app logo", error);
    return null;
  }
}

function sectionLabel(doc: PDFKit.PDFDocument, text: string, x: number, y: number) {
  doc.font("Helvetica-Bold").fontSize(9).fillColor(COLORS.teal).text(text, x, y);
}

function valueBlock(doc: PDFKit.PDFDocument, label: string, value: string, x: number, y: number, width: number) {
  doc.font("Helvetica-Bold").fontSize(7.5).fillColor(COLORS.muted).text(label, x, y);
  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .fillColor(COLORS.ink)
    .text(clean(value), x, y + 14, { width, height: 18, ellipsis: true });
}

function tableText(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  width: number,
  align: "left" | "right",
  heading: boolean,
) {
  doc
    .font(heading ? "Helvetica-Bold" : "Helvetica")
    .fontSize(heading ? 8 : 9.5)
    .fillColor(heading ? COLORS.tealDark : COLORS.ink)
    .text(clean(text), x, y, { width, align, ellipsis: true, height: 16 });
}

function pill(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  width: number,
  height: number,
  text: string,
  background: string,
  foreground: string,
) {
  doc.roundedRect(x, y, width, height, height / 2).fill(background);
  doc.font("Helvetica-Bold").fontSize(8).fillColor(foreground).text(text, x, y + 8, { width, align: "center" });
}

function formatAmount(amount: number) {
  return `BDT ${amount.toLocaleString("en-US")}`;
}

function formatPaymentMethod(method: string) {
  const labels: Record<string, string> = {
    bkash: "bKash",
    nagad: "Nagad",
    bank: "Bank transfer",
    cheque: "Cheque",
    cash: "Cash",
  };
  return labels[method.toLowerCase()] ?? titleCase(method);
}

function formatDate(value: Date) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Dhaka",
  }).format(value);
}

function titleCase(value: string) {
  return clean(value)
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function initials(value: string) {
  return clean(value)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("") || "FN";
}

function clean(value: string) {
  return value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
}

function fittingFontSize(doc: PDFKit.PDFDocument, text: string, width: number, preferred: number, minimum: number) {
  let size = preferred;
  while (size > minimum) {
    doc.fontSize(size);
    if (doc.widthOfString(text) <= width) return size;
    size -= 0.5;
  }
  return minimum;
}
