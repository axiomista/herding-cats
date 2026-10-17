// Copies the page's static files next to the compiled browser script.
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("dist/web", { recursive: true });
for (const f of ["index.html", "style.css"]) copyFileSync(`web/${f}`, `dist/web/${f}`);
