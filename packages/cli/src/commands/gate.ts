import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { ErrorObject } from "ajv";

interface AjvValidator {
  (data: unknown): boolean;
  errors?: ErrorObject[] | null;
}

interface Ajv2020Instance {
  compile(schema: unknown): AjvValidator;
}

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default as new (options: Record<string, unknown>) => Ajv2020Instance;

export interface GateOptions {
  schema: string;
  input: string;
  json?: boolean;
}

export interface GateResult {
  valid: boolean;
  schema: string;
  input: string;
  errors: ErrorObject[];
}

export async function validateJsonSchema(options: GateOptions): Promise<GateResult> {
  const [schema, input] = await Promise.all([
    readJson(options.schema, "schema"),
    readJson(options.input, "input"),
  ]);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  const valid = validate(input);
  return {
    valid: valid === true,
    schema: options.schema,
    input: options.input,
    errors: validate.errors ? [...validate.errors] : [],
  };
}

export async function gateCommand(options: GateOptions): Promise<void> {
  try {
    const result = await validateJsonSchema(options);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (result.valid) {
      process.stdout.write(`valid: ${options.input}\n`);
    } else {
      process.stderr.write(`invalid: ${options.input}\n`);
      for (const error of result.errors) {
        process.stderr.write(`  ${error.instancePath || "/"} ${error.message ?? "validation failed"}\n`);
      }
    }
    if (!result.valid) process.exitCode = 2;
  } catch (error) {
    const result = {
      valid: false,
      schema: options.schema,
      input: options.input,
      errors: [{
        keyword: "io",
        instancePath: "",
        schemaPath: "",
        params: {},
        message: error instanceof Error ? error.message : String(error),
      }],
    } satisfies GateResult;
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stderr.write(`gate error: ${result.errors[0]?.message}\n`);
    process.exitCode = 1;
  }
}

async function readJson(filePath: string, label: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${label} file '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`cannot parse ${label} JSON '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
  }
}
