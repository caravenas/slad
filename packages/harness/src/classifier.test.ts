import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyCommand, classifyRunOutput, highestLevel } from "./classifier.js";

describe("classifyCommand", () => {
  it("clasifica rm -rf como full", () => {
    const result = classifyCommand("rm -rf /tmp/something");
    assert.equal(result.level, "full");
    assert.ok(result.patterns.length > 0);
  });

  it("clasifica sudo como full", () => {
    const result = classifyCommand("sudo apt install something");
    assert.equal(result.level, "full");
  });

  it("clasifica git push --force como full", () => {
    const result = classifyCommand("git push origin main --force");
    assert.equal(result.level, "full");
  });

  it("clasifica npm publish como full", () => {
    const result = classifyCommand("npm publish --access public");
    assert.equal(result.level, "full");
  });

  it("clasifica DROP TABLE como full", () => {
    const result = classifyCommand("DROP TABLE users;");
    assert.equal(result.level, "full");
  });

  it("clasifica npm install como workspace", () => {
    const result = classifyCommand("npm install express");
    assert.equal(result.level, "workspace");
  });

  it("clasifica git commit como workspace", () => {
    const result = classifyCommand("git commit -m 'fix'");
    assert.equal(result.level, "workspace");
  });

  it("clasifica mkdir como workspace", () => {
    const result = classifyCommand("mkdir -p src/components");
    assert.equal(result.level, "workspace");
  });

  it("clasifica cat como read", () => {
    const result = classifyCommand("cat file.txt");
    assert.equal(result.level, "read");
    assert.equal(result.patterns.length, 0);
  });

  it("clasifica ls como read", () => {
    const result = classifyCommand("ls -la");
    assert.equal(result.level, "read");
  });

  it("clasifica grep como read", () => {
    const result = classifyCommand("grep -r 'pattern' ./src");
    assert.equal(result.level, "read");
  });

  it("incluye el comando original en el resultado", () => {
    const cmd = "npm install lodash";
    const result = classifyCommand(cmd);
    assert.equal(result.original, cmd);
  });

  it("incluye reason en el resultado", () => {
    const result = classifyCommand("sudo ls");
    assert.ok(result.reason.length > 0);
  });
});

describe("classifyRunOutput", () => {
  it("clasifica todos los comandos de verification[]", () => {
    const output = {
      taskId: "T1",
      status: "completed" as const,
      summary: "done",
      changedFiles: [],
      verification: [
        { command: "npm test", status: "passed" as const, notes: "" },
        { command: "sudo rm -rf /tmp/build", status: "not_run" as const, notes: "" },
      ],
      reviewerNotes: [],
      followUps: [],
      assumptions: [],
      questions: [],
      humanAnswers: {},
      decisions: [],
    };

    const results = classifyRunOutput(output);
    assert.equal(results.length, 2);
    assert.equal(results[0].level, "read"); // npm test
    assert.equal(results[1].level, "full"); // sudo rm -rf
  });

  it("retorna array vacio si no hay verification", () => {
    const output = {
      taskId: "T1",
      status: "completed" as const,
      summary: "done",
      changedFiles: [],
      verification: [],
      reviewerNotes: [],
      followUps: [],
      assumptions: [],
      questions: [],
      humanAnswers: {},
      decisions: [],
    };
    assert.equal(classifyRunOutput(output).length, 0);
  });
});

describe("highestLevel", () => {
  it("retorna full si hay al menos uno full", () => {
    const classifications = [
      { original: "ls", level: "read" as const, reason: "", patterns: [] },
      { original: "rm -rf /", level: "full" as const, reason: "", patterns: [] },
    ];
    assert.equal(highestLevel(classifications), "full");
  });

  it("retorna workspace si hay workspace pero no full", () => {
    const classifications = [
      { original: "ls", level: "read" as const, reason: "", patterns: [] },
      { original: "git commit", level: "workspace" as const, reason: "", patterns: [] },
    ];
    assert.equal(highestLevel(classifications), "workspace");
  });

  it("retorna read si todos son read", () => {
    const classifications = [
      { original: "ls", level: "read" as const, reason: "", patterns: [] },
      { original: "cat file", level: "read" as const, reason: "", patterns: [] },
    ];
    assert.equal(highestLevel(classifications), "read");
  });

  it("retorna read para array vacio", () => {
    assert.equal(highestLevel([]), "read");
  });
});
