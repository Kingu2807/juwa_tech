/**
 * cli.ts — Point d'entrée en ligne de commande.
 *
 * Usage :
 *   npm run extract                      -> traite les PDF de ./invoices (SAUF ceux déjà extraits)
 *   npm run extract -- ./invoices/x.pdf  -> traite un fichier précis
 *   npm run extract -- --force           -> re-traite TOUT, même les factures déjà extraites
 *
 * Cache : si le JSON d'une facture existe déjà dans output/, on le réutilise au lieu
 * de relancer l'OCR + le LLM (gain de temps et d'appels API). Seules les nouvelles
 * factures sont traitées. --force ignore le cache et force la ré-extraction.
 *
 * Sorties :
 *   - affichage du JSON validé dans le terminal ;
 *   - écriture de pipeline/output/<nom>.json ;
 *   - agrégat écrit dans web/src/data/results.json (consommé par l'interface).
 */
import { config as loadEnv } from "dotenv";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, basename, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// La clé API vit dans le .env à la RACINE du projet (juwa_tech/.env), pas dans pipeline/.
// On charge donc le .env relativement à l'emplacement de ce fichier, quel que soit
// le dossier depuis lequel on lance la commande.
const __dir = dirname(fileURLToPath(import.meta.url)); // .../pipeline/src
loadEnv({ path: resolve(__dir, "..", "..", ".env") }); // -> .../juwa_tech/.env
import { extractInvoice } from "./extract.js";
import { ExtractionResultSchema } from "./schema.js";
import type { ExtractionResult } from "./schema.js";

const INVOICES_DIR = resolve("invoices");
const OUTPUT_DIR = resolve("output");
const WEB_DATA = resolve("..", "web", "src", "data", "results.json");

/**
 * Liste les PDF à traiter : soit ceux passés en argument, soit tout ./invoices.
 * On ignore les arguments qui commencent par "-" (ce sont des options, ex: --force).
 */
async function listPdfs(): Promise<string[]> {
  const fileArgs = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  if (fileArgs.length > 0) return fileArgs.map((a) => resolve(a));

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

/**
 * Tente de relire un résultat déjà extrait sur disque.
 * Renvoie le résultat validé s'il existe et est conforme, sinon null
 * (fichier absent OU corrompu -> on retraitera la facture).
 */
async function loadCached(outPath: string): Promise<ExtractionResult | null> {
  try {
    const txt = await readFile(outPath, "utf8");
    const parsed = ExtractionResultSchema.safeParse(JSON.parse(txt));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function main() {
  // --force (ou -f) : ignore le cache et re-traite tout.
  const args = process.argv.slice(2);
  const force = args.includes("--force") || args.includes("-f");

  const pdfs = await listPdfs();
  await mkdir(OUTPUT_DIR, { recursive: true });

  const results: ExtractionResult[] = [];
  let processed = 0;
  let reused = 0;

  for (const pdf of pdfs) {
    const name = basename(pdf);
    const outPath = join(OUTPUT_DIR, `${basename(name, extname(name))}.json`);

    // 1) Cache : facture déjà extraite -> on réutilise son JSON (sauf si --force).
    if (!force) {
      const cached = await loadCached(outPath);
      if (cached) {
        results.push(cached);
        reused++;
        console.error(
          `⏭  ${name} déjà traité — JSON réutilisé (relance avec --force pour ré-extraire).`
        );
        continue;
      }
    }

    // 2) Nouvelle facture (ou --force) -> extraction complète.
    console.error(`\n▶ Traitement de ${name} ...`);
    try {
      const result = await extractInvoice(pdf);
      results.push(result);
      processed++;

      console.log(JSON.stringify(result, null, 2));
      await writeFile(outPath, JSON.stringify(result, null, 2), "utf8");

      const nbWarn = result.warnings.length;
      console.error(
        `✔ ${name} -> ${outPath}` + (nbWarn ? `  (${nbWarn} avertissement(s))` : "")
      );
    } catch (err) {
      console.error(`✗ Échec sur ${name} : ${(err as Error).message}`);
    }
  }

  // Agrégat pour l'interface : contient TOUT (factures réutilisées + nouvelles).
  await mkdir(join(WEB_DATA, ".."), { recursive: true });
  await writeFile(WEB_DATA, JSON.stringify(results, null, 2), "utf8");
  console.error(
    `\n${results.length} facture(s) dans l'agrégat ` +
      `(${processed} extraite(s), ${reused} réutilisée(s)) -> web/src/data/results.json`
  );
}

main().catch((err) => {
  console.error("Erreur fatale :", err);
  process.exit(1);
});
