/** Canonical AG-UI reader tooling shared by the collector and standalone drift job. */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import * as ts from "typescript";

/** Explicit checkout selection lets BASE and HEAD consume one pinned source tree. */
export function resolveAgUiRepo(fallback: string) {
  return resolve(process.env.AGUI_REPO_PATH || fallback);
}

export const AGUI_CORE_SOURCE = "sdks/typescript/packages/core/src";
export function discoverAgUiSources(repo: string) {
  const core = resolve(repo, AGUI_CORE_SOURCE);
  for (const layout of ["generated", "legacy"] as const) {
    const directory = layout === "generated" ? resolve(core, "generated") : core;
    const types = resolve(directory, layout === "generated" ? "types.ts" : "events.ts");
    const schemas = resolve(directory, layout === "generated" ? "schemas.ts" : "events.ts");
    const required = layout === "generated" ? [types, schemas] : [types, resolve(core, "types.ts")];
    if (required.every((path) => existsSync(path) && statSync(path).isFile()))
      return { layout, directory, types, schemas };
  }
  return null;
}
export interface CanonicalField {
  name: string;
  optional: boolean;
}
export interface CanonicalSchema {
  eventType: string;
  fields: CanonicalField[];
}

/** Parse generated flat validators without executing upstream code or importing Zod. */
export function parseGeneratedAgUi(typesSource: string, schemasSource: string) {
  const typeFile = ts.createSourceFile("types.ts", typesSource, ts.ScriptTarget.Latest, true);
  const schemaFile = ts.createSourceFile("schemas.ts", schemasSource, ts.ScriptTarget.Latest, true);
  const types: string[] = [];
  for (const statement of typeFile.statements) {
    if (!ts.isEnumDeclaration(statement) || statement.name.text !== "EventType") continue;
    for (const member of statement.members) {
      if (!member.initializer || !ts.isStringLiteral(member.initializer))
        throw new Error("Unsupported generated EventType member");
      types.push(member.initializer.text);
    }
  }
  if (!types.length || new Set(types).size !== types.length)
    throw new Error("Missing or duplicate generated EventType values");
  const definitions = new Map<string, ts.Expression>();
  for (const statement of schemaFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer)
        definitions.set(declaration.name.text, declaration.initializer);
    }
  }
  function optional(expression: ts.Expression, seen = new Set<string>()): boolean {
    if (ts.isParenthesizedExpression(expression)) return optional(expression.expression, seen);
    if (ts.isIdentifier(expression)) {
      if (expression.text === "z") return false;
      if (seen.has(expression.text)) throw new Error("Generated schema alias cycle");
      const target = definitions.get(expression.text);
      if (!target) throw new Error(`Unknown generated schema alias ${expression.text}`);
      return optional(target, new Set([...seen, expression.text]));
    }
    if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)) {
      const method = expression.expression;
      if (["optional", "default", "nullish"].includes(method.name.text)) return true;
      // Only the receiver chain affects the field itself. An optional child,
      // array element or transform callback never makes its parent optional.
      return optional(method.expression, seen);
    }
    if (ts.isPropertyAccessExpression(expression)) return optional(expression.expression, seen);
    return false;
  }
  const schemas = new Map<string, CanonicalSchema>();
  for (const [name, initializer] of definitions) {
    if (!name.endsWith("EventSchema") || name === "BaseEventSchema" || name === "EventSchema")
      continue;
    if (
      !ts.isCallExpression(initializer) ||
      !ts.isPropertyAccessExpression(initializer.expression) ||
      !["object", "looseObject", "strictObject"].includes(initializer.expression.name.text) ||
      !initializer.arguments[0] ||
      !ts.isObjectLiteralExpression(initializer.arguments[0])
    )
      throw new Error(`Unsupported generated validator ${name}`);
    const fields: CanonicalField[] = [];
    let eventType: string | undefined;
    for (const member of initializer.arguments[0].properties) {
      if (
        !ts.isPropertyAssignment(member) ||
        !(ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
      )
        throw new Error(`Unsupported generated field in ${name}`);
      const field = member.name.text;
      fields.push({ name: field, optional: optional(member.initializer) });
      if (field === "type" && ts.isCallExpression(member.initializer)) {
        const value = member.initializer.arguments[0];
        if (
          value &&
          ts.isPropertyAccessExpression(value) &&
          ts.isIdentifier(value.expression) &&
          value.expression.text === "EventType"
        )
          eventType = value.name.text;
      }
    }
    if (!eventType || !types.includes(eventType) || schemas.has(eventType))
      throw new Error(`Invalid generated event discriminator in ${name}`);
    schemas.set(eventType, { eventType, fields });
  }
  for (const eventType of types)
    if (!schemas.has(eventType)) throw new Error(`Missing generated validator for ${eventType}`);
  return { types, schemas };
}
