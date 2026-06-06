import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { _extractJsonBody, _fixJsonString, _autoFixParse } from "./adapter.js";

describe("extractJsonBody", () => {
  it("extrae el objeto JSON de texto con fences markdown", () => {
    const raw = "```json\n{\"a\":1}\n```";
    assert.equal(_extractJsonBody(raw), '{"a":1}');
  });

  it("extrae el primer objeto JSON sin fences", () => {
    assert.equal(_extractJsonBody('Here is the result: {"x":2}'), '{"x":2}');
  });

  it("extrae array JSON", () => {
    assert.equal(_extractJsonBody("result: [1,2,3]"), "[1,2,3]");
  });
});

describe("fixJsonString", () => {
  it("elimina trailing commas antes de } y ]", () => {
    assert.equal(_fixJsonString('{"a":1,}'), '{"a":1}');
    assert.equal(_fixJsonString('[1,2,]'), '[1,2]');
  });

  it("escapa salto de línea literal dentro de un string JSON", () => {
    const raw = '{"summary": "line one\nline two"}';
    const fixed = _fixJsonString(raw);
    const parsed = JSON.parse(fixed);
    assert.equal(parsed.summary, "line one\nline two");
  });

  it("escapa carriage return y tab literales dentro de un string JSON", () => {
    const raw = '{"msg": "col1\tcol2\r\nrow2"}';
    const fixed = _fixJsonString(raw);
    const parsed = JSON.parse(fixed);
    assert.equal(parsed.msg, "col1\tcol2\r\nrow2");
  });

  it("no escapa secuencias de escape ya presentes (\\n, \\t)", () => {
    const raw = '{"msg": "line\\nline"}';
    const fixed = _fixJsonString(raw);
    const parsed = JSON.parse(fixed);
    assert.equal(parsed.msg, "line\nline");
  });

  it("no modifica strings que no tienen caracteres de control", () => {
    const raw = '{"a":"hello world","b":42}';
    assert.equal(_fixJsonString(raw), raw);
  });
});

describe("autoFixParse", () => {
  const schema = z.object({ taskId: z.string(), status: z.string() });

  it("parsea JSON válido directamente", () => {
    const raw = '{"taskId":"T1","status":"completed"}';
    const result = _autoFixParse(raw, schema);
    assert.equal(result.success, true);
    if (result.success) assert.equal(result.data.taskId, "T1");
  });

  it("recupera JSON con salto de línea literal en string", () => {
    const raw = `{"taskId":"T1","status":"Implementé los cambios:\nLos schemas se actualizaron."}`;
    const result = _autoFixParse(raw, schema);
    assert.equal(result.success, true);
    if (result.success) assert.ok(result.data.status.includes("\n"));
  });

  it("recupera JSON con trailing comma", () => {
    const raw = '{"taskId":"T1","status":"completed",}';
    const result = _autoFixParse(raw, schema);
    assert.equal(result.success, true);
  });

  it("retorna error de Zod cuando el schema no valida", () => {
    const raw = '{"taskId":123,"status":"completed"}';
    const result = _autoFixParse(raw, schema);
    assert.equal(result.success, false);
    if (!result.success) assert.match(result.error, /Zod validation failed/);
  });

  it("retorna error de JSON parse cuando el input no es JSON reparable", () => {
    const result = _autoFixParse("not json at all", schema);
    assert.equal(result.success, false);
    if (!result.success) assert.match(result.error, /JSON parse failed/);
  });
});
