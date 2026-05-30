import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateInventory } from "./inventory.js";

describe("generateInventory", () => {
  it("detecta todos los providers existentes", () => {
    const inv = generateInventory();
    const names = inv.providers.map((p) => p.name).sort();
    assert.deepStrictEqual(names, ["anthropic", "gemini", "openai", "retry", "timeout"]);
  });

  it("clasifica correctamente el tipo de cada provider", () => {
    const inv = generateInventory();
    const byName = Object.fromEntries(inv.providers.map((p) => [p.name, p.type]));
    assert.strictEqual(byName["anthropic"], "api");
    assert.strictEqual(byName["openai"], "api");
    assert.strictEqual(byName["gemini"], "api");
  });

  it("anthropic provider referencia su SDK", () => {
    const inv = generateInventory();
    const anthropic = inv.providers.find((p) => p.name === "anthropic");
    assert.ok(anthropic, "anthropic provider debe existir");
    assert.ok(
      anthropic.details.some((d) => d.includes("@anthropic-ai/sdk")),
      "debe mencionar el SDK de anthropic",
    );
  });

  it("detecta commands con HITL", () => {
    const inv = generateInventory();
    const explore = inv.commands.find((c) => c.name === "explore");
    assert.ok(explore, "explore command debe existir");
    assert.strictEqual(explore.hasHitl, true, "explore debe tener HITL");
  });

  it("detecta todos los commands del pipeline", () => {
    const inv = generateInventory();
    const names = inv.commands.map((c) => c.name).sort();
    // session.ts exporta sessionStart, sessionList, etc. pero CLI index llama los files
    const expectedCommands = ["ask", "auto", "chat", "evolve", "explore", "learn", "plan", "run", "sessionStart", "snapshot", "stats"];
    for (const expected of expectedCommands) {
      assert.ok(names.includes(expected), `command '${expected}' debe estar en el inventory`);
    }
  });

  it("detecta schemas principales", () => {
    const inv = generateInventory();
    const names = inv.schemas.map((s) => s.name);
    assert.ok(names.includes("ExploreOutput"), "ExploreOutput debe estar");
    assert.ok(names.includes("PlanTask"), "PlanTask debe estar");
    assert.ok(names.includes("RunOutput"), "RunOutput debe estar");
    assert.ok(names.includes("LearnOutput"), "LearnOutput debe estar");
    assert.ok(names.includes("EvolveOutput"), "EvolveOutput debe estar");
  });

  it("los schemas tienen fields no vacíos", () => {
    const inv = generateInventory();
    const exploreSchema = inv.schemas.find((s) => s.name === "ExploreOutput");
    assert.ok(exploreSchema, "ExploreOutput schema debe existir");
    assert.ok(exploreSchema.fields.length > 0, "ExploreOutput debe tener fields");
    assert.ok(exploreSchema.fields.includes("intent"), "ExploreOutput debe tener el field 'intent'");
  });

  it("detecta el ProjectInventory schema en la lista de schemas", () => {
    const inv = generateInventory();
    const names = inv.schemas.map((s) => s.name);
    assert.ok(names.includes("ProjectInventory"), "ProjectInventory schema debe estar en el inventory");
  });

  it("cache system está habilitado", () => {
    const inv = generateInventory();
    assert.strictEqual(inv.cacheSystem.enabled, true, "cache debe estar habilitado");
    assert.ok(inv.cacheSystem.strategy.length > 0, "strategy no debe estar vacía");
  });

  it("harness está habilitado y tiene modos", () => {
    const inv = generateInventory();
    assert.strictEqual(inv.harness.enabled, true, "harness debe estar habilitado");
    assert.ok(inv.harness.modes.length > 0, "harness debe tener modos");
    assert.ok(inv.harness.modes.includes("off"), "harness debe incluir modo 'off'");
    assert.ok(inv.harness.modes.includes("on"), "harness debe incluir modo 'on'");
    assert.ok(inv.harness.modes.includes("strict"), "harness debe incluir modo 'strict'");
  });

  it("content hash es estable entre llamadas (cache in-memory)", () => {
    const inv1 = generateInventory();
    const inv2 = generateInventory();
    assert.strictEqual(inv1.contentHash, inv2.contentHash, "el hash debe ser estable");
    // Verificar que es la misma referencia (cache hit)
    assert.strictEqual(inv1, inv2, "debe devolver la misma instancia cacheada");
  });

  it("generatedAt es un ISO timestamp válido", () => {
    const inv = generateInventory();
    const date = new Date(inv.generatedAt);
    assert.ok(!Number.isNaN(date.getTime()), "generatedAt debe ser un timestamp válido");
  });

  it("contentHash tiene 16 caracteres hex", () => {
    const inv = generateInventory();
    assert.match(inv.contentHash, /^[0-9a-f]{16}$/, "contentHash debe ser 16 chars hex");
  });
});
