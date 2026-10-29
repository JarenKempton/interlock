import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://interlock.jarenkempton.dev",
  output: "static",
  build: { inlineStylesheets: "always" },
  devToolbar: { enabled: false },
});
