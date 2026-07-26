/**
 * server.ts — Petit serveur HTTP local qui expose le pipeline à l'interface web.
 *
 * POURQUOI un serveur ?
 * La clé MISTRAL_API_KEY est un SECRET : elle ne doit jamais partir dans le navigateur
 * (sinon n'importe qui pourrait la voler et l'utiliser). Le navigateur envoie donc le
 * fichier (PDF ou image) à ce petit serveur, qui détient la clé, lance l'extraction
 * exactement comme le CLI, et renvoie le JSON résultat.
 *
 * Il n'y a PAS de base de données, PAS d'authentification, PAS de routing. Endpoints :
 *   GET    /api/invoices       liste les extractions du disque (persistance au reload)
 *   POST   /api/extract        extrait une facture (409 si déjà analysée)
 *   PUT    /api/invoice/<nom>  enregistre une facture corrigée / validée
 *   GET    /api/file/<nom>     sert la facture originale (aperçu côte à côte)
 *   DELETE /api/invoice/<nom>  supprime une facture partout (fichier, JSON, agrégat)
 *   GET    /api/health         état du serveur
 *
 * Le « stockage » est simplement le dossier pipeline/output/ : chaque extraction y est
 * écrite, et l'interface le relit au démarrage. Pas de base de données pour autant.
 *
 * Aucune dépendance externe : on utilise le module HTTP natif de Node. Le fichier est
 * envoyé en "corps brut" (les octets directement dans le body de la requête), avec le
 * nom de fichier dans l'en-tête `x-filename`. On évite ainsi tout parsing multipart.
 *
 * Usage :
 *   npm run serve            -> démarre le serveur sur le port 8787 (ou $PORT)
 */
import { config as loadEnv } from "dotenv";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFile, mkdir, readFile, unlink, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";

// La clé API vit dans le .env à la RACINE du projet (juwa_tech/.env), pas dans pipeline/.
// On charge le .env relativement à l'emplacement de ce fichier (même logique que cli.ts),
// quel que soit le dossier depuis lequel on lance la commande.
const __dir = dirname(fileURLToPath(import.meta.url)); // .../pipeline/src
loadEnv({ path: resolve(__dir, "..", "..", ".env") }); // -> .../juwa_tech/.env

import { extractInvoice, recheckInvoice } from "./extract.js";
import { ExtractionResultSchema } from "./schema.js";

/** Port d'écoute — configurable via la variable d'environnement PORT. */
const PORT = Number(process.env.PORT) || 8787;

/**
 * Dossiers du pipeline (résolus par rapport à CE fichier, pas au dossier de lancement) :
 * - invoices/ : les factures déposées via la page web y sont SAUVEGARDÉES (comme celles
 *   qu'on dépose à la main pour le CLI) ;
 * - output/  : le JSON de chaque extraction y est écrit, comme le fait le CLI. Ainsi un
 *   prochain `npm run extract` réutilisera ce cache et inclura la facture dans
 *   l'agrégat web/src/data/results.json (aucun nouvel appel API).
 */
const INVOICES_DIR = resolve(__dir, "..", "invoices");
const OUTPUT_DIR = resolve(__dir, "..", "output");

/** L'agrégat affiché par défaut dans l'interface (celui que le CLI écrit aussi). */
const WEB_RESULTS = resolve(__dir, "..", "..", "web", "src", "data", "results.json");

/** Types de contenu pour servir la facture originale au navigateur. */
const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

/** Chemin du JSON d'extraction correspondant à une facture (output/<nom sans ext>.json). */
function outputPathFor(fileName: string): string {
  return join(OUTPUT_DIR, `${basename(fileName, extname(fileName))}.json`);
}

/**
 * Une facture est considérée « déjà analysée » si son JSON d'extraction existe.
 * On se base sur le JSON (et non sur le PDF) : un fichier déposé dont l'extraction a
 * échoué n'est pas un doublon, il doit pouvoir être retenté.
 */
function alreadyAnalysed(fileName: string): boolean {
  return existsSync(outputPathFor(fileName));
}

/** Extensions de fichiers acceptées (PDF + images de factures scannées). */
const ALLOWED_EXTENSIONS = new Set([".pdf", ".jpg", ".jpeg", ".png", ".webp"]);

/** Taille maximale d'un fichier accepté (garde-fou anti-abus) : ~15 Mo. */
const MAX_BYTES = 15 * 1024 * 1024;

/* ------------------------------- Utilitaires ------------------------------ */

/** Renvoie une réponse JSON avec le bon statut HTTP et les en-têtes CORS. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    // CORS large : en dev, l'UI (port 5173) appelle ce serveur (port 8787).
    // En pratique on passe par le proxy Vite, mais on reste tolérant.
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, PUT, GET, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-filename",
  });
  res.end(payload);
}

/**
 * Lit tout le corps de la requête (les octets du fichier) en mémoire.
 * Rejette si le fichier dépasse la taille maximale autorisée.
 */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BYTES) {
        reject(new Error("Fichier trop volumineux (limite : 15 Mo)."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/* --------------------------- Gestion de l'endpoint ------------------------ */

/**
 * Traite POST /api/extract : reçoit un fichier (PDF ou image), lance le pipeline,
 * renvoie le ExtractionResult validé. En cas d'erreur, renvoie un message lisible —
 * jamais de valeur inventée, on préfère signaler clairement le problème.
 */
async function handleExtract(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // 1) Récupère le nom de fichier d'origine (pour la traçabilité + l'extension).
  const rawName = req.headers["x-filename"];
  const fileName = typeof rawName === "string" && rawName.length > 0 ? rawName : "facture.pdf";
  const ext = extname(fileName).toLowerCase();

  // 2) Vérifie que le type de fichier est supporté.
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    sendJson(res, 415, {
      error: `Format non supporté (${ext || "inconnu"}). Formats acceptés : PDF, JPG, PNG, WebP.`,
    });
    return;
  }

  // 3) Lit les octets du fichier.
  let bytes: Buffer;
  try {
    bytes = await readBody(req);
  } catch (err) {
    sendJson(res, 413, { error: (err as Error).message });
    return;
  }
  if (bytes.length === 0) {
    sendJson(res, 400, { error: "Aucun fichier reçu." });
    return;
  }

  // 4) DOUBLON : une facture du même nom a déjà été analysée. On ne relance pas
  //    l'extraction (économie d'appel API) et on le signale clairement à l'interface.
  if (alreadyAnalysed(fileName)) {
    sendJson(res, 409, {
      error: `« ${fileName} » a déjà été analysée.`,
      duplicate: true,
      name: fileName,
    });
    return;
  }

  // 5) SAUVEGARDE la facture dans pipeline/invoices/ (elle est conservée, exactement
  //    comme une facture déposée à la main). L'extension est gardée : c'est elle qui
  //    permet à runOcr de choisir le bon traitement (PDF vs image).
  await mkdir(INVOICES_DIR, { recursive: true });
  const savedPath = join(INVOICES_DIR, fileName);

  try {
    await writeFile(savedPath, bytes);

    // 6) Lance le pipeline existant (OCR -> LLM -> validation Zod -> contrôles).
    //    sourceDocument = le nom du fichier sauvegardé (traçabilité).
    const result = await extractInvoice(savedPath);
    result.sourceDocument = fileName;

    // 7) Écrit aussi le JSON dans pipeline/output/ (comme le CLI). C'est ce dossier
    //    qui rend les factures PERSISTANTES : l'interface le relit à chaque ouverture.
    await mkdir(OUTPUT_DIR, { recursive: true });
    await writeFile(outputPathFor(fileName), JSON.stringify(result, null, 2), "utf8");

    console.log(`✔ ${fileName} sauvegardé dans invoices/ (+ JSON dans output/)`);
    sendJson(res, 200, result);
  } catch (err) {
    // Erreurs métier attendues (clé manquante, OCR vide, JSON non conforme...) :
    // on renvoie le message tel quel, il est déjà rédigé pour être lisible.
    // La facture reste dans invoices/ : on pourra relancer l'extraction plus tard.
    sendJson(res, 500, { error: (err as Error).message });
  }
}

/**
 * GET /api/invoices — liste TOUTES les extractions présentes sur le disque (output/).
 *
 * C'est ce qui rend les factures persistantes : l'interface appelle cet endpoint à
 * l'ouverture, donc une facture déposée reste visible après un rechargement, tant
 * qu'elle n'a pas été supprimée. Les JSON illisibles ou non conformes sont ignorés
 * silencieusement (on n'affiche jamais une donnée dont on n'est pas sûr de la forme).
 */
async function handleList(res: ServerResponse): Promise<void> {
  const files = await readdir(OUTPUT_DIR).catch(() => [] as string[]);
  const out = [];

  for (const f of files) {
    if (!f.toLowerCase().endsWith(".json")) continue;
    try {
      const raw = JSON.parse(await readFile(join(OUTPUT_DIR, f), "utf8"));
      const parsed = ExtractionResultSchema.safeParse(raw);
      if (parsed.success) out.push(parsed.data);
    } catch {
      /* fichier corrompu : on l'ignore */
    }
  }

  // Plus récentes en premier (l'interface regroupe ensuite par statut).
  out.sort((a, b) => b.meta.extractedAt.localeCompare(a.meta.extractedAt));
  sendJson(res, 200, out);
}

/**
 * GET (ou HEAD) /api/file/<nom> — sert la facture originale (PDF ou image) depuis
 * invoices/, pour l'afficher côte à côte avec son extraction dans l'interface.
 * `basename()` neutralise toute tentative de sortir du dossier (sécurité).
 */
async function handleFile(req: IncomingMessage, res: ServerResponse, rawName: string): Promise<void> {
  const name = basename(decodeURIComponent(rawName));
  const ext = extname(name).toLowerCase();
  const filePath = join(INVOICES_DIR, name);

  if (!MIME[ext] || !existsSync(filePath)) {
    sendJson(res, 404, { error: `Document original introuvable : ${name}` });
    return;
  }

  res.writeHead(200, {
    "Content-Type": MIME[ext],
    "Access-Control-Allow-Origin": "*",
    // Affichage dans la page (iframe), pas téléchargement.
    "Content-Disposition": `inline; filename="${name}"`,
  });
  if (req.method === "HEAD") { res.end(); return; }
  res.end(await readFile(filePath));
}

/**
 * PUT /api/invoice/<nom> — enregistre une facture corrigée et/ou validée.
 *
 * Le navigateur envoie l'objet complet ; on le valide avec le MÊME schéma Zod que
 * l'extraction (rien d'inattendu ne peut être écrit sur le disque), puis on relance les
 * contrôles de cohérence : corriger un prix de ligne peut faire disparaître d'elle-même
 * l'alerte « somme des lignes ≠ total HT ».
 */
async function handleSave(
  req: IncomingMessage,
  res: ServerResponse,
  rawName: string
): Promise<void> {
  const name = basename(decodeURIComponent(rawName));
  const outPath = outputPathFor(name);

  if (!existsSync(outPath)) {
    sendJson(res, 404, { error: `Facture inconnue : ${name}` });
    return;
  }

  let body: Buffer;
  try {
    body = await readBody(req);
  } catch (err) {
    sendJson(res, 413, { error: (err as Error).message });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    sendJson(res, 400, { error: "Corps de requête JSON invalide." });
    return;
  }

  const check = ExtractionResultSchema.safeParse(parsed);
  if (!check.success) {
    sendJson(res, 422, { error: "Facture non conforme au schéma attendu." });
    return;
  }

  // Le nom du document reste celui de l'URL : on n'autorise pas un renommage détourné.
  const updated = recheckInvoice({ ...check.data, sourceDocument: name });
  await writeFile(outPath, JSON.stringify(updated, null, 2), "utf8");

  console.log(`✎ ${name} mis à jour${updated.review?.validated ? " (validée)" : ""}`);
  sendJson(res, 200, updated);
}

/**
 * DELETE /api/invoice/<nom> — supprime une facture PARTOUT où elle vit :
 *   1) le fichier original dans invoices/ ;
 *   2) son extraction dans output/ ;
 *   3) son entrée dans l'agrégat web/src/data/results.json (données par défaut).
 * Chaque étape est tolérante : un fichier déjà absent n'est pas une erreur.
 */
async function handleDelete(res: ServerResponse, rawName: string): Promise<void> {
  const name = basename(decodeURIComponent(rawName));

  // 1) + 2) Fichier original et JSON d'extraction.
  await unlink(join(INVOICES_DIR, name)).catch(() => {});
  await unlink(join(OUTPUT_DIR, `${basename(name, extname(name))}.json`)).catch(() => {});

  // 3) Entrée dans l'agrégat (si l'agrégat existe et la contient).
  try {
    const arr = JSON.parse(await readFile(WEB_RESULTS, "utf8"));
    if (Array.isArray(arr)) {
      const filtered = arr.filter((e) => e?.sourceDocument !== name);
      if (filtered.length !== arr.length) {
        await writeFile(WEB_RESULTS, JSON.stringify(filtered, null, 2), "utf8");
      }
    }
  } catch {
    /* pas d'agrégat lisible : rien à retirer */
  }

  console.log(`🗑  ${name} supprimé (invoices/, output/, results.json)`);
  sendJson(res, 200, { ok: true });
}

/* --------------------------------- Serveur -------------------------------- */

const server = createServer((req, res) => {
  const url = req.url ?? "";
  const method = req.method ?? "GET";

  // Pré-vol CORS (le navigateur envoie parfois une requête OPTIONS avant le POST).
  if (method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  // Endpoint de santé : permet à l'UI de vérifier que le serveur tourne.
  if (method === "GET" && url === "/api/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Endpoint principal : extraction d'une facture.
  if (method === "POST" && url === "/api/extract") {
    handleExtract(req, res).catch((err) => {
      sendJson(res, 500, { error: (err as Error).message });
    });
    return;
  }

  // Liste des factures déjà analysées (persistance au rechargement).
  if (method === "GET" && url === "/api/invoices") {
    handleList(res).catch((err) => {
      sendJson(res, 500, { error: (err as Error).message });
    });
    return;
  }

  // Facture originale (affichée côte à côte avec l'extraction).
  if ((method === "GET" || method === "HEAD") && url.startsWith("/api/file/")) {
    handleFile(req, res, url.slice("/api/file/".length)).catch((err) => {
      sendJson(res, 500, { error: (err as Error).message });
    });
    return;
  }

  // Enregistrement d'une facture corrigée / validée.
  if (method === "PUT" && url.startsWith("/api/invoice/")) {
    handleSave(req, res, url.slice("/api/invoice/".length)).catch((err) => {
      sendJson(res, 500, { error: (err as Error).message });
    });
    return;
  }

  // Suppression d'une facture (fichier + extraction + agrégat).
  if (method === "DELETE" && url.startsWith("/api/invoice/")) {
    handleDelete(res, url.slice("/api/invoice/".length)).catch((err) => {
      sendJson(res, 500, { error: (err as Error).message });
    });
    return;
  }

  sendJson(res, 404, { error: "Route inconnue." });
});

server.listen(PORT, () => {
  console.log(`✅ Serveur d'extraction JUWA prêt sur http://localhost:${PORT}`);
  console.log(`   POST /api/extract  (fichier PDF ou image dans le corps de la requête)`);
});
