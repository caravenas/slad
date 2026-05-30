import kleur from "kleur";

const c = kleur.cyan;
const logo = [
  c("  ▄▄▄▄▄▄  "),
  c("▄████████▄"),
  c("██ ▀  ▀ ██"),
  c("▀████████▀"),
  c("  ▀▀  ▀▀  ")
];

const title = kleur.bold().white("SLAD OS");
const ver = kleur.dim("v1.0.0");
const cwd = process.cwd();
const home = process.env.HOME || process.env.USERPROFILE || "";
const displayPath = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;

const lines = [
  `${logo[0]}   ${title} ${ver}`,
  `${logo[1]}   ${kleur.dim("Agentic OS with high effort")}`,
  `${logo[2]}   ${kleur.dim(displayPath)}`,
  `${logo[3]}`,
  `${logo[4]}`
];

console.log("\n" + lines.join("\n") + "\n");
