/**
 * cli.ts — Point d'entrée en ligne de commande.
 *
 * Usage :
 *   npm run extract                      -> traite tous les PDF de ./invoices
 *   npm run extract -- ./invoices/x.pdf  -> traite un fichier précis
 *
 * Sorties :
 *   - affichage du JSON validé dans le terminal ;
 *   - écriture de pipeline/output/<nom>.json ;
 *   - agrégat écrit dans web/src/data/results.json (consommé par l'interface).
 */
import { config as loadEnv } from "dotenv";
import { readdir, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, basename, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// La clé API vit dans le .env à la RACINE du projet (juwa_tech/.env), pas dans pipeline/.
// On charge donc le .env relativement à l'emplacement de ce fichier, quel que soit
// le dossier depuis lequel on lance la commande.
const __dir = dirname(fileURLToPath(import.meta.url)); // .../pipeline/src
loadEnv({ path: resolve(__dir, "..", "..", ".env") }); // -> .../juwa_tech/.env
import { extractInvoice } from "./extract.js";
import type { ExtractionResult } from "./schema.js";

const INVOICES_DIR = resolve("invoices");
const OUTPUT_DIR = resolve("output");
const WEB_DATA = resolve("..", "web", "src", "data", "results.json");

/** Liste les PDF à traiter : soit ceux passés en argument, soit tout ./invoices. */
async function listPdfs(): Promise<string[]> {
  const args = process.argv.slice(2);
  if (args.length > 0) return args.map((a) => resolve(a));

  const entries = await readdir(INVOICES_DIR).catch(() => []);
  const pdfs = entries
    .filter((f) => extname(f).toLowerCase() === ".pdf")
    .map((f) => join(INVOICES_DIR, f));

  if (pdfs.length === 0) {
    console.error(
      `Aucun PDF trouvé dans ${INVOICES_DIR}. Dépose tes factures ou passe un chemin en argument.`
    );
    process.exit(1);
  }
  return pdfs;
}

async function main() {
  const pdfs = await listPdfs();
  const results: ExtractionResult[] = [];

  for (const pdf of pdfs) {
    const name = basename(pdf);
    console.error(`\n▶ Traitement de ${name} ...`);
    try {
      const result = await extractInvoice(pdf);
      results.push(result);

      // Affichage lisible dans le terminal.
      console.log(JSON.stringify(result, null, 2));

      // Fichier individuel.
      await mkdir(OUTPUT_DIR, { recursive: true });
      const outPath = join(OUTPUT_DIR, `${basename(name, extname(name))}.json`);
      await writeFile(outPath, JSON.stringify(result, null, 2), "utf8");

      const nbWarn = result.warnings.length;
      console.error(
        `✔ ${name} -> ${outPath}` + (nbWarn ? `  (${nbWarn} avertissement(s))` : "")
      );
    } catch (err) {
      console.error(`✗ Échec sur ${name} : ${(err as Error).message}`);
    }
  }

  // Agrégat pour l'interface (même si vide, pour un état propre).
  await mkdir(join(WEB_DATA, ".."), { recursive: true });
  await writeFile(WEB_DATA, JSON.stringify(results, null, 2), "utf8");
  console.error(
    `\n${results.length} facture(s) extraite(s). Agrégat -> web/src/data/results.json`
  );
}

main().catch((err) => {
  console.error("Erreur fatale :", err);
  process.exit(1);
});
