import { copyFile } from "node:fs/promises";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://interlock.build",
  output: "static",
  integrations: [{
    name: "install-scripts",
    hooks: {
      "astro:build:done": async ({ dir }) => {
        await Promise.all(["install.sh", "install.ps1"].map((name) =>
          copyFile(new URL(`../scripts/${name}`, import.meta.url), new URL(name, dir)),
        ));
      },
    },
  }],
  build: { inlineStylesheets: "always" },
  devToolbar: { enabled: false },
});
