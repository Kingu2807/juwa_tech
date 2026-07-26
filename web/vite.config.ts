import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// __dirname n'existe pas dans un fichier ESM : on le reconstruit depuis import.meta.url.
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Port du serveur d'extraction (le petit serveur du dossier `pipeline`).
 * Doit correspondre au PORT utilisé par pipeline/src/server.ts.
 */
const API_PORT = 8787;

/**
 * Plugin maison : démarre automatiquement le serveur d'extraction du pipeline
 * quand on lance `npm run dev`, et l'arrête proprement à la fermeture.
 *
 * POURQUOI ? Pour qu'une SEULE commande (`npm run dev`) suffise au salarié : elle lance
 * à la fois l'interface (Vite) ET le serveur qui traite les PDF/images. Pas besoin
 * d'ouvrir deux terminaux.
 *
 * FALLBACK : si jamais ce démarrage automatique pose souci, on peut toujours lancer le
 * serveur à la main dans un autre terminal :  cd ../pipeline && npm run serve
 */
function pipelineServerPlugin(): PluginOption {
  let child: ChildProcess | null = null;

  return {
    name: "juwa-pipeline-server",
    apply: "serve", // uniquement en mode dev (`npm run dev`), pas au build.
    configureServer() {
      const pipelineDir = resolve(__dirname, "..", "pipeline");

      // On lance `npm run serve` dans le dossier pipeline. shell:true pour que la
      // commande `npm` soit trouvée sous Windows comme sous macOS/Linux.
      child = spawn("npm", ["run", "serve"], {
        cwd: pipelineDir,
        shell: true,
        stdio: "inherit", // les logs du serveur s'affichent dans le même terminal.
      });

      // À l'arrêt de Vite (Ctrl+C), on coupe aussi le serveur d'extraction.
      const stop = () => {
        if (child && !child.killed) child.kill();
      };
      process.on("exit", stop);
      process.on("SIGINT", () => {
        stop();
        process.exit();
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), pipelineServerPlugin()],
  server: {
    proxy: {
      // Le front appelle "/api/..." (chemin relatif) ; Vite redirige vers le serveur
      // d'extraction. Avantage : pas de problème de CORS, et l'URL du serveur reste
      // configurée à un seul endroit.
      "/api": {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
});
