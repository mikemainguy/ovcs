import { debug } from './debug.js';
import { getLanguageFromPath, sha256 } from './chunker.js';
import { createRequire } from 'node:module';
import path from 'node:path';

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

export {
    parseFile,
    getParser,
    createSearchableText
};
