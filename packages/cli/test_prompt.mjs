import { input } from "@inquirer/prompts";
import kleur from "kleur";

const separator = "─".repeat(process.stdout.columns || 80);
console.log(kleur.dim(separator));

async function run() {
  const answer = await input({ 
    message: kleur.bold().cyan("❯"),
    theme: { prefix: "" }
  });
  console.log("You typed:", answer);
}
// don't await, just let it run then we kill it or send input
run();
