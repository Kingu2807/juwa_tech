import { finalizeInvoice } from "./extract.js";
import { ExtractedInvoiceSchema, ExtractionResultSchema } from "./schema.js";
import type { ExtractedInvoice } from "./schema.js";

const f = (value: unknown, confidence = "high", warning: string | null = null) =>
  ({ value, confidence, warning });

let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  cond ? pass++ : fail++;
};

// 1) Facture propre et cohérente : 2*10 + ... = totalHT
const clean: ExtractedInvoice = {
  supplier: f("Garnier SA"),
  invoiceDate: f("01/07/2026"),
  invoiceNumber: f("FA-1"),
  lineItems: [
    { designation: f("Vis"), quantity: f(10), unitPrice: f(12.5) },
    { designation: f("Chevilles"), quantity: f(6), unitPrice: f(4.9) },
  ],
  totalHT: f(154.4),
  totalTTC: f(185.28),
} as any;
const r1 = finalizeInvoice(ExtractedInvoiceSchema.parse(clean), "facture-1.pdf", 1800);
check("facture propre -> 0 warning", r1.warnings.length === 0);
check("resultat final valide (Zod)", ExtractionResultSchema.safeParse(r1).success);

// 2) Incoherence somme des lignes vs total HT
const mismatch = { ...clean, totalHT: f(999) } as ExtractedInvoice;
const r2 = finalizeInvoice(ExtractedInvoiceSchema.parse(mismatch), "f2.pdf", 1800);
check("total HT incoherent -> warning", r2.warnings.some(w => w.includes("somme des lignes")));

// 3) Champs nuls -> warning champs cles + pas de valeur inventee
const missing: ExtractedInvoice = {
  supplier: f("Quincaillerie", "medium"),
  invoiceDate: f(null, "low", "date illisible"),
  invoiceNumber: f(null, "low", "numero coupe"),
  lineItems: [{ designation: f("Cable", "medium"), quantity: f(null, "low", "qte illisible"), unitPrice: f(1.35, "medium") }],
  totalHT: f(null, "low", "montant illisible"),
  totalTTC: f(96.5, "medium"),
} as any;
const r3 = finalizeInvoice(ExtractedInvoiceSchema.parse(missing), "scan.pdf", 210);
check("champs nuls -> warning champs cles", r3.warnings.some(w => w.includes("Champs clés non lisibles")));
check("null reste null (pas de valeur inventee)", r3.totalHT.value === null && r3.invoiceDate.value === null);

// 4) OCR pauvre
const r4 = finalizeInvoice(ExtractedInvoiceSchema.parse(clean), "s.pdf", 40);
check("ocr pauvre -> warning", r4.warnings.some(w => w.includes("OCR très pauvre")));

// 5) TTC < HT
const badttc = { ...clean, totalTTC: f(10) } as ExtractedInvoice;
const r5 = finalizeInvoice(ExtractedInvoiceSchema.parse(badttc), "b.pdf", 1800);
check("TTC < HT -> warning", r5.warnings.some(w => w.includes("TTC")));

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
