import { type ImapFlowError, type ParserErrorCode } from '../errors.js';
import type { ImapAttributeList, ParserOptions } from './types.js';
import type { ParserInstance } from './parser-instance.js';
/**
 * A node of the parse tree built by TokenParser. `type` is false for a node that has not
 * been classified yet, 'TREE' for the root, and otherwise the token or structure type
 * (ATOM, string, LITERAL, SEQUENCE, LIST, SECTION, PARTIAL).
 */
export interface TokenNode {
    /** Created with the first child, a leaf token does not carry an empty array */
    childNodes?: TokenNode[] | undefined;
    type: string | false;
    value: string | Buffer;
    isClosed: boolean;
    parentNode?: TokenNode | undefined;
    depth: number;
    startPos?: number | undefined;
    endPos?: number | undefined;
    literalType?: string | undefined;
    /** Digits accumulated as a string while the literal marker is read, converted to a number once the marker closes */
    literalLength?: string | number | undefined;
    literalPlus?: boolean | undefined;
    started?: boolean | undefined;
    chBuffer?: Buffer | undefined;
    chPos?: number | undefined;
    /** Set on a FETCH data item whose nesting exceeded MAX_NODE_DEPTH, see createNode() */
    truncated?: boolean | undefined;
}
/**
 * The parent object a TokenParser reads the parsed command from
 */
export interface TokenParserParent {
    command?: string | undefined;
}
/**
 * Tokenizes an IMAP attribute string into a tree of typed nodes.
 * Handles all IMAP data types: atoms, quoted strings, literals (including literal8),
 * sequences, lists (parenthesized groups), sections (bracketed groups), and partial ranges.
 * Enforces a maximum nesting depth of {@link MAX_NODE_DEPTH} to prevent stack overflow
 * from malicious input: a FETCH data item that nests deeper is replaced by NIL and listed in
 * `truncatedAttributes`, any other input that nests deeper fails to parse.
 */
export declare class TokenParser {
    str: string;
    options: ParserOptions;
    parent: TokenParserParent | ParserInstance;
    maxLiteralSize: number;
    maxResponseTokens: number;
    /** Nodes created so far, checked against maxResponseTokens */
    tokenCount: number;
    tree: TokenNode;
    currentNode: TokenNode;
    pos: number;
    state: number;
    /** The keys of the FETCH data items that were dropped for exceeding MAX_NODE_DEPTH */
    truncatedAttributes: string[];
    expectedLiteralType?: string | false | undefined;
    /**
     * Creates a new TokenParser.
     *
     * @param parent - The parent ParserInstance that owns this token parser. Used to access the parsed command for context-sensitive parsing.
     * @param startPos - The starting position offset in the original input, used for error reporting.
     * @param str - The attribute string to tokenize.
     * @param options - Parser options.
     * @param options.literalPlus - Whether the LITERAL+ extension is in use.
     * @param options.literals - Pre-parsed literal values from the input stream.
     * @param options.maxLiteralSize - Maximum size (in bytes) of a literal parsed inline
     *   from the input, i.e. when no pre-parsed literal buffers were supplied. Defaults to 1GB.
     * @param options.maxResponseTokens - Maximum number of parse tree nodes, see MAX_RESPONSE_TOKENS.
     */
    constructor(parent: TokenParserParent | ParserInstance, startPos?: number | undefined, str?: string | null | undefined, options?: ParserOptions | undefined);
    /**
     * Builds a numbered parser error that carries a bounded copy of the input and the position
     * (and character, when there is one) where parsing failed.
     *
     * @param message - The error message
     * @param code - The numbered parser error code
     * @param pos - Position of the failure in the original input
     * @param chr - The offending character
     * @returns The error to throw
     */
    parserError(message: string, code: ParserErrorCode, pos: number, chr?: string | undefined): ImapFlowError;
    /**
     * Processes the input string and returns the parsed attributes as a flat array of typed objects.
     * Each attribute is an object with a `type` (e.g., "ATOM", "STRING", "LITERAL", "SEQUENCE")
     * and a `value` property. Lists are represented as nested arrays. Sections and partials are
     * attached as properties on the preceding attribute object.
     *
     * @returns A promise that resolves to an array of parsed attribute objects and nested arrays.
     * @throws {Error} If the input contains syntax errors or unclosed nodes.
     */
    getAttributes(): Promise<ImapAttributeList>;
    /**
     * Creates a new node in the parse tree. Each node represents a token or structural
     * element (e.g., atom, string, literal, list, section, partial). The node is automatically
     * appended to the parent's childNodes array if a parent is provided.
     *
     * @param parentNode - The parent node to attach this node to. If omitted, creates a root node.
     * @param startPos - The starting position of this node in the original input string.
     * @returns The newly created node with childNodes, type, value, and isClosed properties.
     * @throws {Error} If the nesting depth exceeds MAX_NODE_DEPTH outside a FETCH data item, or
     *   the response has more than maxResponseTokens nodes.
     */
    createNode(parentNode?: TokenNode | undefined, startPos?: number | undefined): TokenNode;
    /**
     * Whether the line being parsed is a message data response (`* 12 FETCH (...)`): a numeric
     * command with FETCH as its first attribute. Only those get the per-item nesting fallback.
     *
     * @returns True for an untagged FETCH response
     */
    isFetchResponse(): boolean;
    /**
     * Marks the FETCH data item a too deeply nested node belongs to as truncated and records
     * its key (the item before it in the list, e.g. BODYSTRUCTURE) for the caller to report.
     *
     * @param node - The node at MAX_NODE_DEPTH whose child would exceed the limit
     */
    truncateFetchDataItem(node: TokenNode): void;
    /**
     * Processes the entire input string character by character using a state machine.
     * Transitions between states (NORMAL, ATOM, STRING, LITERAL, SEQUENCE, PARTIAL, TEXT)
     * based on the current character and builds the parse tree. This is the main parsing
     * loop that drives the tokenization.
     *
     * @throws {Error} If the input contains unexpected characters, unclosed structures, or other syntax errors.
     */
    processString(): Promise<void>;
}
