import { debug } from './debug.js';
import { getLanguageFromPath, sha256 } from './chunker.js';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { OVCSSETTINGS } from './const.js';

let Parser = null;
let treeSitterAvailable = false;
let initPromise = null;

const languages = {};

async function initTreeSitter() {
    try {
        const { Parser: TreeSitter, Language } = await import('web-tree-sitter');
        await TreeSitter.init();
        Parser = TreeSitter;

        const require = createRequire(import.meta.url);

        languages.javascript = await Language.load(require.resolve('tree-sitter-javascript/tree-sitter-javascript.wasm'));
        languages.typescript = await Language.load(require.resolve('tree-sitter-typescript/tree-sitter-typescript.wasm'));

        treeSitterAvailable = true;
        debug('Tree-sitter (WASM) loaded successfully');
    } catch (err) {
        debug('Tree-sitter not available:', err.message);
    }
}

// Initialize once, lazily
function ensureInitialized() {
    if (!initPromise) {
        initPromise = initTreeSitter();
    }
    return initPromise;
}

const parsers = {};

function getParser(language) {
    if (!treeSitterAvailable) {
        return null;
    }

    if (parsers[language]) {
        return parsers[language];
    }

    try {
        const parser = new Parser();

        switch (language) {
            case 'javascript':
                parser.setLanguage(languages.javascript);
                break;
            case 'typescript':
                parser.setLanguage(languages.typescript);
                break;
            default:
                debug('Unsupported language for AST parsing:', language);
                return null;
        }

        parsers[language] = parser;
        return parser;
    } catch (err) {
        debug('Error creating parser for', language, ':', err.message);
        return null;
    }
}

async function parseFile(content, filePath, fileId) {
    await ensureInitialized();

    const language = getLanguageFromPath(filePath);
    if (!language) {
        debug('Cannot determine language for:', filePath);
        return [];
    }

    const parser = getParser(language);
    if (!parser) {
        return [];
    }

    try {
        const tree = parser.parse(content);
        const nodes = extractNodes(tree.rootNode, filePath, fileId, language, content);
        debug(`Extracted ${nodes.length} AST nodes from ${filePath}`);
        return nodes;
    } catch (err) {
        debug('Error parsing file:', filePath, err);
        return [];
    }
}

function extractNodes(rootNode, filePath, fileId, language, content) {
    const nodes = [];
    const lines = content.split('\n');

    function traverse(node, parentId = null) {
        const nodeInfo = extractNodeInfo(node, filePath, fileId, language, parentId, lines);
        if (nodeInfo) {
            nodes.push(nodeInfo);
            parentId = nodeInfo.id;
        }

        for (let i = 0; i < node.childCount; i++) {
            traverse(node.child(i), parentId);
        }
    }

    traverse(rootNode);
    return nodes;
}

function extractNodeInfo(node, filePath, fileId, language, parentId, lines) {
    const nodeType = categorizeNodeType(node.type, language);
    if (!nodeType) return null;

    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;

    const nodeName = extractNodeName(node, language);
    if (!nodeName) return null;

    const signature = extractSignature(node, lines);
    const dependencies = extractDependencies(node, language);

    const id = sha256(`${filePath}:${nodeType}:${nodeName}:${startLine}`);

    return {
        id,
        file_path: filePath,
        file_id: fileId,
        node_type: nodeType,
        node_name: nodeName,
        parent_id: parentId || '',
        start_line: startLine,
        end_line: endLine,
        language,
        signature,
        dependencies: dependencies.join(','),
        vector: [],
        updated_at: new Date().toISOString()
    };
}

function categorizeNodeType(treeSitterType, language) {
    const functionTypes = [
        'function_declaration',
        'function_expression',
        'arrow_function',
        'method_definition',
        'function'
    ];

    const classTypes = [
        'class_declaration',
        'class_expression',
        'class'
    ];

    const importTypes = [
        'import_statement',
        'import_declaration'
    ];

    const exportTypes = [
        'export_statement',
        'export_declaration',
        'export_default_declaration'
    ];

    if (functionTypes.includes(treeSitterType)) return 'function';
    if (classTypes.includes(treeSitterType)) return 'class';
    if (importTypes.includes(treeSitterType)) return 'import';
    if (exportTypes.includes(treeSitterType)) return 'export';

    return null;
}

// Helper to find child node by type (WASM API uses namedChild/namedChildCount)
function findChildByType(node, type) {
    for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child.type === type) return child;
    }
    return null;
}

// Helper to find first identifier child
function findIdentifier(node) {
    for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child.type === 'identifier' || child.type === 'property_identifier') return child;
    }
    return null;
}

function extractNodeName(node, language) {
    if (node.type === 'function_declaration' || node.type === 'class_declaration') {
        const nameNode = findIdentifier(node);
        return nameNode ? nameNode.text : null;
    }

    if (node.type === 'method_definition') {
        const nameNode = findIdentifier(node);
        return nameNode ? nameNode.text : null;
    }

    if (node.type === 'arrow_function' || node.type === 'function_expression') {
        const parent = node.parent;
        if (parent && parent.type === 'variable_declarator') {
            const nameNode = findIdentifier(parent);
            return nameNode ? nameNode.text : null;
        }
        return `anonymous_${node.startPosition.row}`;
    }

    if (node.type === 'import_statement' || node.type === 'import_declaration') {
        const sourceNode = findChildByType(node, 'string');
        return sourceNode ? sourceNode.text.replace(/['"]/g, '') : 'import';
    }

    if (node.type === 'export_statement' || node.type === 'export_declaration') {
        const declarationNode = findChildByType(node, 'function_declaration') ||
                               findChildByType(node, 'class_declaration') ||
                               findChildByType(node, 'lexical_declaration');
        if (declarationNode) {
            const nameNode = findIdentifier(declarationNode);
            return nameNode ? nameNode.text : 'export';
        }
        return 'export';
    }

    return null;
}

function extractSignature(node, lines) {
    const startLine = node.startPosition.row;
    const endLine = Math.min(startLine + 2, node.endPosition.row);

    const signatureLines = lines.slice(startLine, endLine + 1);
    let signature = signatureLines.join('\n').trim();

    if (signature.length > 200) {
        signature = signature.substring(0, 200) + '...';
    }

    const bodyIndex = signature.indexOf('{');
    if (bodyIndex > 0) {
        signature = signature.substring(0, bodyIndex).trim();
    }

    return signature;
}

function extractDependencies(node, language) {
    const dependencies = [];

    function findIdentifiers(n) {
        if (!n) return;
        if (n.type === 'identifier' || n.type === 'property_identifier') {
            dependencies.push(n.text);
        }
        if (n.type === 'call_expression') {
            const funcNode = n.namedChildCount > 0 ? n.namedChild(0) : null;
            if (funcNode) {
                dependencies.push(funcNode.text);
            }
        }
        for (let i = 0; i < n.childCount; i++) {
            findIdentifiers(n.child(i));
        }
    }

    findIdentifiers(node);

    return [...new Set(dependencies)].slice(0, 20);
}

function createSearchableText(nodeInfo) {
    const parts = [
        nodeInfo.node_type,
        nodeInfo.node_name,
        nodeInfo.signature
    ];

    if (nodeInfo.dependencies) {
        parts.push(nodeInfo.dependencies.replace(/,/g, ' '));
    }

    return parts.join(' ');
}

/**
 * Extract detailed import information from a file's AST.
 * Returns array of { local_name, source_path, exported_name } for each import specifier.
 */
function extractImportDetails(rootNode, filePath) {
    const imports = [];

    function traverse(node) {
        if (node.type === 'import_statement' || node.type === 'import_declaration') {
            const sourceNode = findChildByType(node, 'string');
            if (!sourceNode) return;
            const sourcePath = sourceNode.text.replace(/['"]/g, '');

            // import_clause contains the specifiers
            const importClause = findChildByType(node, 'import_clause');
            if (importClause) {
                // Default import: import foo from './bar'
                const defaultId = findIdentifier(importClause);
                if (defaultId && defaultId.type === 'identifier') {
                    // Check it's actually a default import, not a named one
                    const namedImports = findChildByType(importClause, 'named_imports');
                    const nsImport = findChildByType(importClause, 'namespace_import');
                    if (!namedImports || defaultId.startPosition.column < namedImports.startPosition.column) {
                        if (!nsImport || defaultId.startPosition.column < nsImport.startPosition.column) {
                            imports.push({
                                local_name: defaultId.text,
                                source_path: sourcePath,
                                exported_name: 'default'
                            });
                        }
                    }
                }

                // Namespace import: import * as ns from './bar'
                const nsImport = findChildByType(importClause, 'namespace_import');
                if (nsImport) {
                    const nsId = findIdentifier(nsImport);
                    if (nsId) {
                        imports.push({
                            local_name: nsId.text,
                            source_path: sourcePath,
                            exported_name: '*'
                        });
                    }
                }

                // Named imports: import { a, b as c } from './bar'
                const namedImports = findChildByType(importClause, 'named_imports');
                if (namedImports) {
                    for (let i = 0; i < namedImports.namedChildCount; i++) {
                        const spec = namedImports.namedChild(i);
                        if (spec.type === 'import_specifier') {
                            const names = [];
                            for (let j = 0; j < spec.namedChildCount; j++) {
                                const child = spec.namedChild(j);
                                if (child.type === 'identifier') {
                                    names.push(child.text);
                                }
                            }
                            if (names.length === 2) {
                                // import { original as alias }
                                imports.push({
                                    local_name: names[1],
                                    source_path: sourcePath,
                                    exported_name: names[0]
                                });
                            } else if (names.length === 1) {
                                imports.push({
                                    local_name: names[0],
                                    source_path: sourcePath,
                                    exported_name: names[0]
                                });
                            }
                        }
                    }
                }
            }
        }

        for (let i = 0; i < node.childCount; i++) {
            traverse(node.child(i));
        }
    }

    traverse(rootNode);
    return imports;
}

/**
 * Resolve a relative import source path to an actual file path.
 * Tries common extensions and /index.* patterns.
 */
function resolveImportPath(sourcePath, importingFilePath, workingDir) {
    // Skip package imports (non-relative)
    if (!sourcePath.startsWith('.') && !sourcePath.startsWith('/')) {
        return null;
    }

    const importingDir = path.dirname(path.resolve(workingDir, importingFilePath));
    const basePath = path.resolve(importingDir, sourcePath);
    const extensions = Object.keys(OVCSSETTINGS.LANGUAGE_MAP);

    // Try exact path first
    if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) {
        return path.relative(workingDir, basePath);
    }

    // Try with extensions
    for (const ext of extensions) {
        const withExt = basePath + ext;
        if (fs.existsSync(withExt)) {
            return path.relative(workingDir, withExt);
        }
    }

    // Try /index.*
    for (const ext of extensions) {
        const indexPath = path.join(basePath, 'index' + ext);
        if (fs.existsSync(indexPath)) {
            return path.relative(workingDir, indexPath);
        }
    }

    return null;
}

/**
 * Extract call expressions from a function AST node.
 * Returns array of { callee_name, call_line, call_type }.
 */
function extractCallExpressions(functionNode) {
    const calls = [];

    function traverse(node) {
        if (!node) return;

        if (node.type === 'call_expression') {
            const funcNode = node.namedChildCount > 0 ? node.namedChild(0) : null;
            if (funcNode) {
                if (funcNode.type === 'identifier') {
                    calls.push({
                        callee_name: funcNode.text,
                        call_line: node.startPosition.row + 1,
                        call_type: 'direct'
                    });
                } else if (funcNode.type === 'member_expression') {
                    const obj = findChildByType(funcNode, 'identifier') || findChildByType(funcNode, 'this');
                    const prop = findChildByType(funcNode, 'property_identifier');
                    if (prop) {
                        calls.push({
                            callee_name: prop.text,
                            call_line: node.startPosition.row + 1,
                            call_type: 'method',
                            object_name: obj ? obj.text : null
                        });
                    }
                }
            }
        }

        if (node.type === 'new_expression') {
            const classNode = node.namedChildCount > 0 ? node.namedChild(0) : null;
            if (classNode && classNode.type === 'identifier') {
                calls.push({
                    callee_name: classNode.text,
                    call_line: node.startPosition.row + 1,
                    call_type: 'constructor'
                });
            }
        }

        for (let i = 0; i < node.childCount; i++) {
            traverse(node.child(i));
        }
    }

    traverse(functionNode);
    return calls;
}

/**
 * Build call edges for a parsed file.
 * Takes AST nodes (from parseFile), the root tree node, import details, and a resolver function.
 *
 * @param {Object} rootNode - tree-sitter root node
 * @param {Array} astNodes - parsed AST nodes from parseFile()
 * @param {Array} importDetails - from extractImportDetails()
 * @param {string} filePath - relative file path
 * @param {string} fileId - sha256 of filePath
 * @param {Function} resolveSymbol - async (name, sourceFile) => { id, name, file_path } or null
 * @returns {Array} call edge records ready for LanceDB
 */
async function buildCallEdges(rootNode, astNodes, importDetails, filePath, fileId, resolveSymbol) {
    const edges = [];

    // Build a map of local function names -> AST node IDs for intra-file resolution
    const localFunctions = new Map();
    for (const node of astNodes) {
        if (node.node_type === 'function' || node.node_type === 'class') {
            localFunctions.set(node.node_name, node);
        }
    }

    // Build import lookup: local_name -> { source_path, exported_name }
    const importMap = new Map();
    for (const imp of importDetails) {
        importMap.set(imp.local_name, imp);
    }

    // For each function node, extract its call expressions and resolve them
    const functionNodes = astNodes.filter(n => n.node_type === 'function');

    for (const funcNode of functionNodes) {
        // Find the corresponding tree-sitter node by line range
        const tsNode = findTreeSitterNode(rootNode, funcNode.start_line, funcNode.end_line);
        if (!tsNode) continue;

        const calls = extractCallExpressions(tsNode);
        const seenCallees = new Set();

        for (const call of calls) {
            const edgeKey = `${funcNode.id}>${call.callee_name}:${call.call_line}`;
            if (seenCallees.has(edgeKey)) continue;
            seenCallees.add(edgeKey);

            let calleeId = '';
            let calleeFile = '';
            let resolved = 0;
            let sourceModule = '';

            // Look up import info for the callee or its object
            const impInfo = importMap.get(call.callee_name) || (call.object_name && importMap.get(call.object_name)) || null;

            // 1. Try intra-file resolution
            const localMatch = localFunctions.get(call.callee_name);
            if (localMatch) {
                calleeId = localMatch.id;
                calleeFile = filePath;
                resolved = 1;
            }
            // 2. Try cross-file resolution via imports
            else if (impInfo && resolveSymbol) {
                sourceModule = impInfo.source_path || '';
                const targetName = call.call_type === 'method' ? call.callee_name : impInfo.exported_name;
                const resolved_symbol = await resolveSymbol(targetName, impInfo.resolved_path);
                if (resolved_symbol) {
                    calleeId = resolved_symbol.id;
                    calleeFile = resolved_symbol.file_path;
                    resolved = 1;
                }
            }

            // Capture source module even if resolution failed
            if (!resolved && impInfo) {
                sourceModule = impInfo.source_path || '';
            }

            if (!calleeId) {
                calleeId = sha256(`unresolved:${call.callee_name}`);
            }

            // Build a qualified callee name that includes the object/module context
            let qualifiedName = call.callee_name;
            if (call.object_name && call.call_type === 'method') {
                qualifiedName = call.object_name + '.' + call.callee_name;
            }

            const edgeId = sha256(`${funcNode.id}>${calleeId}:${call.call_line}`);

            edges.push({
                id: edgeId,
                caller_id: funcNode.id,
                callee_id: calleeId,
                caller_name: funcNode.node_name,
                callee_name: qualifiedName,
                caller_file: filePath,
                callee_file: calleeFile,
                call_line: call.call_line,
                call_type: call.call_type,
                source_module: sourceModule,
                file_id: fileId,
                resolved,
                vector: [],
                updated_at: new Date().toISOString()
            });
        }
    }

    return edges;
}

/**
 * Find the tree-sitter node that corresponds to a given line range.
 */
function findTreeSitterNode(rootNode, startLine, endLine) {
    function traverse(node) {
        const nodeStart = node.startPosition.row + 1;
        const nodeEnd = node.endPosition.row + 1;

        if (nodeStart === startLine && nodeEnd === endLine) {
            return node;
        }

        if (nodeStart <= startLine && nodeEnd >= endLine) {
            for (let i = 0; i < node.namedChildCount; i++) {
                const result = traverse(node.namedChild(i));
                if (result) return result;
            }
        }

        return null;
    }

    return traverse(rootNode);
}

/**
 * Enhanced parseFile that also returns the tree root node, import details, and call edges.
 */
async function parseFileWithCallGraph(content, filePath, fileId, workingDir, resolveSymbol) {
    await ensureInitialized();

    const language = getLanguageFromPath(filePath);
    if (!language) return { astNodes: [], importDetails: [], callEdges: [] };

    const parser = getParser(language);
    if (!parser) return { astNodes: [], importDetails: [], callEdges: [] };

    try {
        const tree = parser.parse(content);
        const astNodes = extractNodes(tree.rootNode, filePath, fileId, language, content);

        // Extract import details
        const rawImports = extractImportDetails(tree.rootNode, filePath);

        // Resolve import paths
        const importDetails = rawImports.map(imp => ({
            ...imp,
            resolved_path: workingDir ? resolveImportPath(imp.source_path, filePath, workingDir) : null
        }));

        // Build call edges
        const callEdges = await buildCallEdges(
            tree.rootNode, astNodes, importDetails, filePath, fileId, resolveSymbol
        );

        debug(`Extracted ${astNodes.length} AST nodes, ${importDetails.length} imports, ${callEdges.length} call edges from ${filePath}`);
        return { astNodes, importDetails, callEdges };
    } catch (err) {
        debug('Error parsing file with call graph:', filePath, err);
        return { astNodes: [], importDetails: [], callEdges: [] };
    }
}

export {
    parseFile,
    parseFileWithCallGraph,
    extractImportDetails,
    extractCallExpressions,
    resolveImportPath,
    getParser,
    createSearchableText
};
