import { isBuiltin } from 'node:module';
import ts from 'typescript';

export type ImportForm =
  | 'import'
  | 'side-effect'
  | 'export-from'
  | 'export-star'
  | 'import-equals'
  | 'dynamic-import'
  | 'require'
  | 'import-type-node';

export interface ImportRef {
  specifier: string;
  form: ImportForm;
  typeOnly: boolean;
}

export type Target =
  | { kind: 'builtin'; name: string }
  | { kind: 'package'; name: string }
  | { kind: 'file'; path: string }
  | { kind: 'unresolved' };

/** A call's literal specifier; `''` marks a non-literal one, which never resolves. */
const specifierArg = (node: ts.CallExpression): string => {
  const [arg] = node.arguments;
  return arg !== undefined && ts.isStringLiteralLike(arg) ? arg.text : '';
};

const importRef = (node: ts.Node): ImportRef | undefined => {
  if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return undefined;
  const clause = node.importClause;
  return {
    specifier: node.moduleSpecifier.text,
    form: clause === undefined ? 'side-effect' : 'import',
    typeOnly: clause?.phaseModifier === ts.SyntaxKind.TypeKeyword,
  };
};

const exportRef = (node: ts.Node): ImportRef | undefined => {
  if (!ts.isExportDeclaration(node) || node.moduleSpecifier === undefined || !ts.isStringLiteral(node.moduleSpecifier)) return undefined;
  const star = node.exportClause === undefined || ts.isNamespaceExport(node.exportClause);
  return { specifier: node.moduleSpecifier.text, form: star ? 'export-star' : 'export-from', typeOnly: node.isTypeOnly };
};

const importEqualsRef = (node: ts.Node): ImportRef | undefined => {
  if (!ts.isImportEqualsDeclaration(node) || !ts.isExternalModuleReference(node.moduleReference)) return undefined;
  const { expression } = node.moduleReference;
  return ts.isStringLiteral(expression) ? { specifier: expression.text, form: 'import-equals', typeOnly: node.isTypeOnly } : undefined;
};

const callRef = (node: ts.Node): ImportRef | undefined => {
  if (!ts.isCallExpression(node)) return undefined;
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return { specifier: specifierArg(node), form: 'dynamic-import', typeOnly: false };
  const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
  return isRequire ? { specifier: specifierArg(node), form: 'require', typeOnly: false } : undefined;
};

const importTypeRef = (node: ts.Node): ImportRef | undefined => {
  if (!ts.isImportTypeNode(node) || !ts.isLiteralTypeNode(node.argument)) return undefined;
  const { literal } = node.argument;
  return ts.isStringLiteral(literal) ? { specifier: literal.text, form: 'import-type-node', typeOnly: true } : undefined;
};

/** Every module reference in a TypeScript source, with whether it survives to runtime. */
export const scanImports = (fileName: string, text: string): ImportRef[] => {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const refs: ImportRef[] = [];
  const visit = (node: ts.Node): void => {
    const ref = importRef(node) ?? exportRef(node) ?? importEqualsRef(node) ?? callRef(node) ?? importTypeRef(node);
    if (ref !== undefined) refs.push(ref);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return refs;
};

/** The package a bare specifier names, without any subpath. */
export const packageName = (specifier: string): string => {
  const parts = specifier.split('/');
  return (specifier.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1)).join('/');
};

const RESOLVE_OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  noEmit: true,
  jsx: ts.JsxEmit.Preserve,
};

/** Classifies a specifier as a Node built-in, a package, or a resolved local file. */
export const resolveImport = (specifier: string, fromFile: string): Target => {
  if (specifier === '') return { kind: 'unresolved' };
  if (specifier.startsWith('node:') || isBuiltin(specifier)) {
    return { kind: 'builtin', name: specifier.replace(/^node:/, '').split('/')[0] ?? specifier };
  }
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return { kind: 'package', name: packageName(specifier) };
  const resolved = ts.resolveModuleName(specifier, fromFile, RESOLVE_OPTIONS, ts.sys).resolvedModule;
  return resolved === undefined ? { kind: 'unresolved' } : { kind: 'file', path: resolved.resolvedFileName };
};
