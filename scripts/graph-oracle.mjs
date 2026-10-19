// Ground truth for the code graph, from the TypeScript compiler itself.
//
// The code graph resolves call sites by NAME. The compiler resolves them by TYPE, with full
// module resolution, and it is the thing the language is defined by - so for TypeScript it is an
// oracle in the strict sense, not another heuristic to compare against.
//
// Two decisions keep the comparison honest, and both narrow it:
//
//  1. Only plain `f()` and `a.b()` call sites are in the universe. `new X()` is excluded because
//     our TypeScript query captures it as `name.reference.class`, which `isAssertedCall` already
//     excludes - counting constructor calls as misses would be grading the graph against a claim
//     it does not make. Element-access calls (`a["b"]()`) and calls of expressions
//     (`(f || g)()`) are excluded for the same reason. All three are counted and reported, so
//     the narrowing is visible rather than quietly assumed.
//
//  2. Only in-repo targets count. A call into node_modules or the standard library is not
//     something the graph is wrong about - it is outside what the graph indexes. Those sites are
//     reported separately and are what the "out of universe" bucket in grading.ts is for.
//
// Usage: node scripts/graph-oracle.mjs <project-root> [tsconfig-name]

import ts from 'typescript';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** Forward slashes, repo-relative - the same shape the graph store uses as a key. */
function rel(root, absolute) {
  return relative(root, absolute).split('\\').join('/');
}

function isInRepo(root, fileName) {
  const normalised = fileName.split('\\').join('/');
  const rootPosix = root.split('\\').join('/');
  if (!normalised.toLowerCase().startsWith(rootPosix.toLowerCase())) return false;
  return !normalised.includes('/node_modules/');
}

/**
 * Where a resolved declaration should be said to live.
 *
 * `checker.getResolvedSignature` points at the function-like node, which for `const f = () => {}`
 * is the arrow function - an anonymous node with no name. The graph records the *variable* as the
 * definition, so the anchor climbs to whatever actually carries the name. This is the same shape
 * question that exposed the missing const-function pattern in the TypeScript query; getting it
 * wrong here would hide that class of bug instead of measuring it.
 */
function declarationAnchor(decl) {
  let node = decl;
  for (let hops = 0; hops < 4 && node; hops++) {
    if (node.name && ts.isIdentifier(node.name)) break;
    if (
      ts.isVariableDeclaration(node) ||
      ts.isPropertyAssignment(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isFunctionDeclaration(node)
    ) {
      break;
    }
    node = node.parent;
  }
  const anchored = node ?? decl;
  const named = anchored.name && ts.isIdentifier(anchored.name) ? anchored.name : anchored;
  const file = decl.getSourceFile();
  return {
    fileName: file.fileName,
    line: file.getLineAndCharacterOfPosition(named.getStart(file)).line + 1,
    name: anchored.name && ts.isIdentifier(anchored.name) ? anchored.name.text : undefined,
  };
}

/** The identifier a call site names, or undefined for shapes the graph never captures. */
function calleeIdentifier(call) {
  const target = call.expression;
  if (ts.isIdentifier(target)) return target;
  if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.name)) return target.name;
  return undefined;
}

/**
 * Builds the oracle for one project.
 *
 * Returns every call site the compiler could rule on, with the diagnostics needed to see what
 * was left out. Filtering (tests in or out, say) is the caller's job, applied to the same
 * program, so the cells of a comparison table differ by exactly one thing.
 */
export function buildOracle(projectRoot, tsconfigName = 'tsconfig.json') {
  const root = resolve(projectRoot);
  const configPath = isAbsolute(tsconfigName) ? tsconfigName : join(root, tsconfigName);

  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) {
    throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath));
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
  const checker = program.getTypeChecker();

  const sites = [];
  /** Constructor sites with in-repo targets: reported to size the exclusion, never graded. */
  const constructorSites = [];
  const diagnostics = {
    sourceFiles: 0,
    callExpressions: 0,
    newExpressions: 0,
    unsupportedShape: 0,
    unresolved: 0,
    ambiguous: 0,
    outOfRepo: 0,
    inRepo: 0,
    // Constructor calls resolved the same way, reported but never graded. Excluding `new X()`
    // from the graded universe is defensible - the graph does not claim it as a call - but the
    // exclusion also flatters recall, so the size of what it removes has to be on the record
    // rather than left for a reader to wonder about.
    constructorsInRepo: 0,
  };

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (!isInRepo(root, sourceFile.fileName)) continue;
    diagnostics.sourceFiles++;

    const fromPath = rel(root, sourceFile.fileName);

    const visit = (node) => {
      if (ts.isNewExpression(node)) {
        diagnostics.newExpressions++;
        const callee = calleeIdentifier(node);
        if (callee) record(node, callee, fromPath, sourceFile, false);
      }

      if (ts.isCallExpression(node)) {
        diagnostics.callExpressions++;
        const callee = calleeIdentifier(node);
        if (!callee) {
          diagnostics.unsupportedShape++;
        } else {
          record(node, callee, fromPath, sourceFile, true);
        }
      }
      ts.forEachChild(node, visit);
    };

    const record = (call, callee, fromPath, sourceFile, graded) => {
      const fromLine = sourceFile.getLineAndCharacterOfPosition(callee.getStart(sourceFile)).line + 1;
      const name = callee.text;

      // Type-directed resolution first: this is the signature the compiler would actually call.
      const signature = checker.getResolvedSignature(call);
      let declarations = signature?.declaration ? [signature.declaration] : [];

      // Fall back to the symbol only when the call is untyped (`any`), where no signature exists
      // but a declaration often still does.
      if (declarations.length === 0) {
        let symbol = checker.getSymbolAtLocation(callee);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
          try {
            symbol = checker.getAliasedSymbol(symbol);
          } catch {
            // An unresolvable alias stays unresolved; that is a real answer, not an error.
          }
        }
        declarations = symbol?.declarations ?? [];
      }

      if (declarations.length === 0) {
        if (graded) diagnostics.unresolved++;
        return;
      }

      const anchors = declarations
        .map((d) => declarationAnchor(d))
        .filter((a) => isInRepo(root, a.fileName));

      if (anchors.length === 0) {
        if (graded) diagnostics.outOfRepo++;
        return;
      }

      const files = new Set(anchors.map((a) => a.fileName));
      if (files.size > 1) {
        // Declaration merging or overloads spread across files: the compiler itself does not
        // reduce this to one target, so it cannot be used to grade one.
        if (graded) diagnostics.ambiguous++;
        return;
      }

      if (!graded) {
        diagnostics.constructorsInRepo++;
        constructorSites.push({ fromPath, fromLine, name });
        return;
      }

      diagnostics.inRepo++;
      sites.push({
        fromPath,
        fromLine,
        name,
        toPath: rel(root, anchors[0].fileName),
        toLine: anchors[0].line,
        toName: anchors[0].name,
      });
    };

    visit(sourceFile);
  }

  return { root, configPath, sites, constructorSites, diagnostics };
}

if (import.meta.url === `file:///${process.argv[1].split('\\').join('/')}`) {
  const [, , projectRoot = '.', tsconfigName = 'tsconfig.json'] = process.argv;
  const started = Date.now();
  const oracle = buildOracle(projectRoot, tsconfigName);
  console.log(`oracle for ${oracle.root}`);
  console.log(`  config ${oracle.configPath}`);
  console.log(`  built in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log('');
  for (const [key, value] of Object.entries(oracle.diagnostics)) {
    console.log(`  ${key.padEnd(18)} ${String(value).padStart(7)}`);
  }
  console.log('');
  console.log(`  in-repo edges ${oracle.sites.length}`);
  for (const site of oracle.sites.slice(0, 10)) {
    console.log(`    ${site.fromPath}:${site.fromLine} ${site.name}() -> ${site.toPath}:${site.toLine}`);
  }
}
