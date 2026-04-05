// www/js/latex/index.js
// Public API - single import point for the LaTeX module.
// Re-exports from all submodules for convenient access.

// Core
export { Tokenizer, tokenize, TokenType } from './core/tokenizer.js';
export { Parser, parse, parseSource } from './core/parser.js';
export {
  LatexNode, NodeType,
  createDocument, createCommand, createEnvironment, createGroup,
  createText, createMath, createParameter, createComment,
  createWhitespace, createSuperscript, createSubscript,
  createFraction, createMatrix, createTable, createTableRow, createTableCell,
  createList, createListItem, createSection, createArgument, createRaw,
  Visitor, TransformVisitor,
  flattenText, isEmpty,
} from './core/ast.js';
export { LatexError, Severity, createError, collectErrors } from './core/errors.js';
export { LaTeXPipeline, processLatex } from './core/pipeline.js';
export { MacroExpander } from './core/macro-expander.js';
export { TOCGenerator } from './core/toc-generator.js';
export { CrossRefResolver } from './core/crossref.js';
export { LaTeXValidator, validateLatex, ValidationSeverity } from './core/validator.js';
export { LatexToMarkdown, latexToMarkdown } from './core/to-markdown.js';
export { CompletionEngine, getLatexCompletions } from './core/completion.js';
export { LaTeXValidator, validateLatex, ValidationSeverity } from './core/validator.js';
export { LatexToMarkdown, latexToMarkdown } from './core/to-markdown.js';
export { CompletionEngine, getLatexCompletions } from './core/completion.js';

// Engines
export { TeXCore } from './engines/tex-core.js';
export { ETeXExtensions } from './engines/etex-extensions.js';
export { LaTeXMacros } from './engines/latex-macros.js';
export { PdfTeXExtensions } from './engines/pdftex-extensions.js';
export { ConTeXtMacros } from './engines/context-macros.js';
export { OmegaExtensions } from './engines/omega-extensions.js';
export { PTexConcepts } from './engines/ptex-concepts.js';
export { BibTeXEngine } from './engines/bibtex-engine.js';

// Renderers
export { KaTeXRenderer, renderKatex } from './renderers/katex-renderer.js';
export { MathJaxRenderer, renderMathJax } from './renderers/mathjax-renderer.js';
export { HTMLRenderer, renderToHTML } from './renderers/html-renderer.js';
export { ImageExporter, exportMathImage } from './renderers/image-export.js';

// Live Processing
export { StreamProcessor } from './live/stream-processor.js';
export { TokenTracker } from './live/token-tracker.js';
export { PendingManager } from './live/pending-manager.js';

// Environments
export {
  MATH_ENVIRONMENTS, isMathEnvironment, getMathEnvConfig, renderMathEnvironment,
} from './environments/math-envs.js';
export {
  TEXT_ENVIRONMENTS, isTextEnvironment, renderTextEnvironment,
  renderListItem, renderDescriptionItem, renderTabular,
} from './environments/text-envs.js';
export {
  FLOAT_ENVIRONMENTS, isFloatEnvironment, renderFloatEnvironment,
} from './environments/float-envs.js';
export {
  isStructuralEnvironment, getStructuralType, renderStructuralEnvironment,
  getAllStructuralTypes,
} from './environments/structural-envs.js';
export {
  PREAMBLE_COMMANDS, isPreambleCommand, renderPreambleSection,
} from './environments/preamble-envs.js';

// Syntax
export { highlightLatex, wrapHighlighted } from './syntax/highlighter.js';

// Packages
export { AMS_COMMANDS, processAmsMath, getAmsCommands, isAmsCommand } from './packages/amsmath.js';
export { parseIncludeGraphics, renderIncludeGraphics } from './packages/graphicx.js';
export { processHyperref } from './packages/hyperref.js';
export { processColor, getNamedColors, parseColor, mixColors, colorWithOpacity } from './packages/xcolor.js';
export { processBooktabs } from './packages/booktabs.js';
export { processAlgorithm, highlightAlgorithmKeyword, getAlgoKeywords } from './packages/algorithm.js';
export { processTikZ } from './packages/tikz.js';
export { processBeamer, BEAMER_THEMES, BEAMER_BLOCK_TYPES } from './packages/beamer.js';
export { GlossaryEngine } from './packages/glossary.js';
export { IndexEngine } from './packages/index.js';

// Utils
export { getIcon, icon, iconNames } from './utils/icons.js';
export { findMatchingBrace, findAllMatchingBraces, isBalanced, extractBraceContent, extractBracketContent } from './utils/delimiter-matcher.js';
export { parseLength, parseLengthExpression, lengthToCSS } from './utils/length-parser.js';
export { parseColor as parseColorUtil, mixColors as mixColorsUtil, colorWithOpacity as colorWithOpacityUtil } from './utils/color-parser.js';

// Legacy compatibility - re-export from old location for gradual migration
export { preprocessLatexText, extractMath, injectMath, normalizeDelimiters } from '../chat/latex/index.js';
export { parseBibtex, getAllBibtexEntries, renderCitation, renderBibliography } from '../chat/latex/index.js';
export { renderLatexCodeblock } from '../chat/latex/index.js';


