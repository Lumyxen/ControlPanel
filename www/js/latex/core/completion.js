// www/js/latex/core/completion.js
// LaTeX completion/suggestions engine: provides autocomplete for commands, environments, symbols.

import { MATH_ENVIRONMENTS } from '../environments/math-envs.js';
import { TEXT_ENVIRONMENTS } from '../environments/text-envs.js';
import { FLOAT_ENVIRONMENTS } from '../environments/float-envs.js';

// Comprehensive LaTeX command database
const COMMANDS = {
  // Text formatting
  '\\textbf': { snippet: '\\textbf{${1:text}}', description: 'Bold text', category: 'text' },
  '\\textit': { snippet: '\\textit{${1:text}}', description: 'Italic text', category: 'text' },
  '\\texttt': { snippet: '\\texttt{${1:text}}', description: 'Typewriter text', category: 'text' },
  '\\textrm': { snippet: '\\textrm{${1:text}}', description: 'Roman (serif) text', category: 'text' },
  '\\textsf': { snippet: '\\textsf{${1:text}}', description: 'Sans-serif text', category: 'text' },
  '\\textsc': { snippet: '\\textsc{${1:text}}', description: 'Small caps text', category: 'text' },
  '\\textsl': { snippet: '\\textsl{${1:text}}', description: 'Slanted text', category: 'text' },
  '\\emph': { snippet: '\\emph{${1:text}}', description: 'Emphasized text', category: 'text' },
  '\\underline': { snippet: '\\underline{${1:text}}', description: 'Underlined text', category: 'text' },
  '\\overline': { snippet: '\\overline{${1:text}}', description: 'Overlined text', category: 'text' },
  '\\text': { snippet: '\\text{${1:text}}', description: 'Text in math mode', category: 'text' },
  '\\mbox': { snippet: '\\mbox{${1:text}}', description: 'Text box (no line break)', category: 'text' },
  '\\makebox': { snippet: '\\makebox[${1:width}][${2:c}]{${3:text}}', description: 'Box with width and alignment', category: 'text' },
  '\\fbox': { snippet: '\\fbox{${1:text}}', description: 'Framed box', category: 'text' },
  '\\framebox': { snippet: '\\framebox[${1:width}][${2:c}]{${3:text}}', description: 'Framed box with width', category: 'text' },
  '\\parbox': { snippet: '\\parbox[${1:c}]{${2:width}}{${3:text}}', description: 'Paragraph box', category: 'text' },
  '\\raisebox': { snippet: '\\raisebox{${1:height}}{${2:text}}', description: 'Raise or lower text', category: 'text' },
  '\\scalebox': { snippet: '\\scalebox{${1:factor}}{${2:text}}', description: 'Scale text', category: 'text' },

  // Math - Greek letters
  '\\alpha': { snippet: '\\alpha', description: 'Greek lowercase alpha', category: 'math-greek' },
  '\\beta': { snippet: '\\beta', description: 'Greek lowercase beta', category: 'math-greek' },
  '\\gamma': { snippet: '\\gamma', description: 'Greek lowercase gamma', category: 'math-greek' },
  '\\delta': { snippet: '\\delta', description: 'Greek lowercase delta', category: 'math-greek' },
  '\\epsilon': { snippet: '\\epsilon', description: 'Greek lowercase epsilon', category: 'math-greek' },
  '\\varepsilon': { snippet: '\\varepsilon', description: 'Greek lowercase varepsilon', category: 'math-greek' },
  '\\zeta': { snippet: '\\zeta', description: 'Greek lowercase zeta', category: 'math-greek' },
  '\\eta': { snippet: '\\eta', description: 'Greek lowercase eta', category: 'math-greek' },
  '\\theta': { snippet: '\\theta', description: 'Greek lowercase theta', category: 'math-greek' },
  '\\vartheta': { snippet: '\\vartheta', description: 'Greek lowercase vartheta', category: 'math-greek' },
  '\\iota': { snippet: '\\iota', description: 'Greek lowercase iota', category: 'math-greek' },
  '\\kappa': { snippet: '\\kappa', description: 'Greek lowercase kappa', category: 'math-greek' },
  '\\lambda': { snippet: '\\lambda', description: 'Greek lowercase lambda', category: 'math-greek' },
  '\\mu': { snippet: '\\mu', description: 'Greek lowercase mu', category: 'math-greek' },
  '\\nu': { snippet: '\\nu', description: 'Greek lowercase nu', category: 'math-greek' },
  '\\xi': { snippet: '\\xi', description: 'Greek lowercase xi', category: 'math-greek' },
  '\\pi': { snippet: '\\pi', description: 'Greek lowercase pi', category: 'math-greek' },
  '\\rho': { snippet: '\\rho', description: 'Greek lowercase rho', category: 'math-greek' },
  '\\sigma': { snippet: '\\sigma', description: 'Greek lowercase sigma', category: 'math-greek' },
  '\\tau': { snippet: '\\tau', description: 'Greek lowercase tau', category: 'math-greek' },
  '\\upsilon': { snippet: '\\upsilon', description: 'Greek lowercase upsilon', category: 'math-greek' },
  '\\phi': { snippet: '\\phi', description: 'Greek lowercase phi', category: 'math-greek' },
  '\\varphi': { snippet: '\\varphi', description: 'Greek lowercase varphi', category: 'math-greek' },
  '\\chi': { snippet: '\\chi', description: 'Greek lowercase chi', category: 'math-greek' },
  '\\psi': { snippet: '\\psi', description: 'Greek lowercase psi', category: 'math-greek' },
  '\\omega': { snippet: '\\omega', description: 'Greek lowercase omega', category: 'math-greek' },
  '\\Gamma': { snippet: '\\Gamma', description: 'Greek uppercase Gamma', category: 'math-greek' },
  '\\Delta': { snippet: '\\Delta', description: 'Greek uppercase Delta', category: 'math-greek' },
  '\\Theta': { snippet: '\\Theta', description: 'Greek uppercase Theta', category: 'math-greek' },
  '\\Lambda': { snippet: '\\Lambda', description: 'Greek uppercase Lambda', category: 'math-greek' },
  '\\Xi': { snippet: '\\Xi', description: 'Greek uppercase Xi', category: 'math-greek' },
  '\\Pi': { snippet: '\\Pi', description: 'Greek uppercase Pi', category: 'math-greek' },
  '\\Sigma': { snippet: '\\Sigma', description: 'Greek uppercase Sigma', category: 'math-greek' },
  '\\Upsilon': { snippet: '\\Upsilon', description: 'Greek uppercase Upsilon', category: 'math-greek' },
  '\\Phi': { snippet: '\\Phi', description: 'Greek uppercase Phi', category: 'math-greek' },
  '\\Psi': { snippet: '\\Psi', description: 'Greek uppercase Psi', category: 'math-greek' },
  '\\Omega': { snippet: '\\Omega', description: 'Greek uppercase Omega', category: 'math-greek' },

  // Math - operators
  '\\sum': { snippet: '\\sum_{${1:i=0}}^{${2:n}} ${3:a_i}', description: 'Summation', category: 'math-operators' },
  '\\prod': { snippet: '\\prod_{${1:i=0}}^{${2:n}} ${3:a_i}', description: 'Product', category: 'math-operators' },
  '\\int': { snippet: '\\int_{${1:a}}^{${2:b}} ${3:f(x)}\\,dx', description: 'Integral', category: 'math-operators' },
  '\\iint': { snippet: '\\iint_{${1:D}} ${2:f(x,y)}\\,dx\\,dy', description: 'Double integral', category: 'math-operators' },
  '\\iiint': { snippet: '\\iiint_{${1:V}} ${2:f(x,y,z)}\\,dV', description: 'Triple integral', category: 'math-operators' },
  '\\oint': { snippet: '\\oint_{${1:C}} ${2:f(z)}\\,dz', description: 'Contour integral', category: 'math-operators' },
  '\\lim': { snippet: '\\lim_{${1:x \\to ${2:0}}} ${3:f(x)}', description: 'Limit', category: 'math-operators' },
  '\\max': { snippet: '\\max_{${1:x \\in S}} ${2:f(x)}', description: 'Maximum', category: 'math-operators' },
  '\\min': { snippet: '\\min_{${1:x \\in S}} ${2:f(x)}', description: 'Minimum', category: 'math-operators' },
  '\\sup': { snippet: '\\sup ${1:S}', description: 'Supremum', category: 'math-operators' },
  '\\inf': { snippet: '\\inf ${1:S}', description: 'Infimum', category: 'math-operators' },
  '\\det': { snippet: '\\det(${1:A})', description: 'Determinant', category: 'math-operators' },
  '\\dim': { snippet: '\\dim(${1:V})', description: 'Dimension', category: 'math-operators' },
  '\\ker': { snippet: '\\ker(${1:f})', description: 'Kernel', category: 'math-operators' },
  '\\hom': { snippet: '\\hom(${1:A}, ${2:B})', description: 'Homomorphism', category: 'math-operators' },

  // Math - relations
  '\\leq': { snippet: '\\leq', description: 'Less than or equal', category: 'math-relations' },
  '\\geq': { snippet: '\\geq', description: 'Greater than or equal', category: 'math-relations' },
  '\\neq': { snippet: '\\neq', description: 'Not equal', category: 'math-relations' },
  '\\approx': { snippet: '\\approx', description: 'Approximately equal', category: 'math-relations' },
  '\\equiv': { snippet: '\\equiv', description: 'Equivalent', category: 'math-relations' },
  '\\sim': { snippet: '\\sim', description: 'Similar', category: 'math-relations' },
  '\\simeq': { snippet: '\\simeq', description: 'Asymptotically equal', category: 'math-relations' },
  '\\cong': { snippet: '\\cong', description: 'Congruent', category: 'math-relations' },
  '\\in': { snippet: '\\in', description: 'Element of', category: 'math-relations' },
  '\\notin': { snippet: '\\notin', description: 'Not element of', category: 'math-relations' },
  '\\subset': { snippet: '\\subset', description: 'Subset', category: 'math-relations' },
  '\\supset': { snippet: '\\supset', description: 'Superset', category: 'math-relations' },
  '\\subseteq': { snippet: '\\subseteq', description: 'Subset or equal', category: 'math-relations' },
  '\\supseteq': { snippet: '\\supseteq', description: 'Superset or equal', category: 'math-relations' },
  '\\ll': { snippet: '\\ll', description: 'Much less than', category: 'math-relations' },
  '\\gg': { snippet: '\\gg', description: 'Much greater than', category: 'math-relations' },
  '\\propto': { snippet: '\\propto', description: 'Proportional to', category: 'math-relations' },

  // Math - arrows
  '\\rightarrow': { snippet: '\\rightarrow', description: 'Right arrow', category: 'math-arrows' },
  '\\leftarrow': { snippet: '\\leftarrow', description: 'Left arrow', category: 'math-arrows' },
  '\\leftrightarrow': { snippet: '\\leftrightarrow', description: 'Left-right arrow', category: 'math-arrows' },
  '\\Rightarrow': { snippet: '\\Rightarrow', description: 'Right double arrow', category: 'math-arrows' },
  '\\Leftarrow': { snippet: '\\Leftarrow', description: 'Left double arrow', category: 'math-arrows' },
  '\\Leftrightarrow': { snippet: '\\Leftrightarrow', description: 'Left-right double arrow', category: 'math-arrows' },
  '\\mapsto': { snippet: '\\mapsto', description: 'Maps to', category: 'math-arrows' },
  '\\longrightarrow': { snippet: '\\longrightarrow', description: 'Long right arrow', category: 'math-arrows' },
  '\\longleftarrow': { snippet: '\\longleftarrow', description: 'Long left arrow', category: 'math-arrows' },
  '\\hookrightarrow': { snippet: '\\hookrightarrow', description: 'Right hook arrow', category: 'math-arrows' },
  '\\hookleftarrow': { snippet: '\\hookleftarrow', description: 'Left hook arrow', category: 'math-arrows' },
  '\\to': { snippet: '\\to', description: 'To (right arrow)', category: 'math-arrows' },

  // Math - structures
  '\\frac': { snippet: '\\frac{${1:numerator}}{${2:denominator}}', description: 'Fraction', category: 'math-structures' },
  '\\dfrac': { snippet: '\\dfrac{${1:numerator}}{${2:denominator}}', description: 'Display fraction', category: 'math-structures' },
  '\\tfrac': { snippet: '\\tfrac{${1:numerator}}{${2:denominator}}', description: 'Text fraction', category: 'math-structures' },
  '\\sqrt': { snippet: '\\sqrt{${1:x}}', description: 'Square root', category: 'math-structures' },
  '\\sqrt[n]': { snippet: '\\sqrt[${1:n}]{${2:x}}', description: 'Nth root', category: 'math-structures' },
  '\\binom': { snippet: '\\binom{${1:n}}{${2:k}}', description: 'Binomial coefficient', category: 'math-structures' },
  '\\overset': { snippet: '\\overset{${1:top}}{${2:bottom}}', description: 'Stack symbols', category: 'math-structures' },
  '\\underset': { snippet: '\\underset{${1:bottom}}{${2:top}}', description: 'Stack symbols below', category: 'math-structures' },
  '\\overbrace': { snippet: '\\overbrace{${1:x}}^{${2:n}}', description: 'Overbrace', category: 'math-structures' },
  '\\underbrace': { snippet: '\\underbrace{${1:x}}_{${2:n}}', description: 'Underbrace', category: 'math-structures' },
  '\\overline': { snippet: '\\overline{${1:x}}', description: 'Overline', category: 'math-structures' },
  '\\underline': { snippet: '\\underline{${1:x}}', description: 'Underline', category: 'math-structures' },
  '\\widehat': { snippet: '\\widehat{${1:xyz}}', description: 'Wide hat', category: 'math-structures' },
  '\\widetilde': { snippet: '\\widetilde{${1:xyz}}', description: 'Wide tilde', category: 'math-structures' },
  '\\vec': { snippet: '\\vec{${1:x}}', description: 'Vector arrow', category: 'math-structures' },
  '\\hat': { snippet: '\\hat{${1:x}}', description: 'Hat accent', category: 'math-structures' },
  '\\tilde': { snippet: '\\tilde{${1:x}}', description: 'Tilde accent', category: 'math-structures' },
  '\\bar': { snippet: '\\bar{${1:x}}', description: 'Bar accent', category: 'math-structures' },
  '\\dot': { snippet: '\\dot{${1:x}}', description: 'Dot accent', category: 'math-structures' },
  '\\ddot': { snippet: '\\ddot{${1:x}}', description: 'Double dot accent', category: 'math-structures' },

  // Math - delimiters
  '\\left': { snippet: '\\left${1:(} ${2:content} \\right${3:)}', description: 'Left delimiter', category: 'math-delimiters' },
  '\\right': { snippet: '\\right${1:)}', description: 'Right delimiter', category: 'math-delimiters' },
  '\\big': { snippet: '\\big${1:(}', description: 'Big delimiter', category: 'math-delimiters' },
  '\\Big': { snippet: '\\Big${1:(}', description: 'Big delimiter', category: 'math-delimiters' },
  '\\bigg': { snippet: '\\bigg${1:(}', description: 'Bigg delimiter', category: 'math-delimiters' },
  '\\Bigg': { snippet: '\\Bigg${1:(}', description: 'Bigg delimiter', category: 'math-delimiters' },

  // Math - dots
  '\\dots': { snippet: '\\dots', description: 'Dots (context sensitive)', category: 'math-dots' },
  '\\cdots': { snippet: '\\cdots', description: 'Centered dots', category: 'math-dots' },
  '\\vdots': { snippet: '\\vdots', description: 'Vertical dots', category: 'math-dots' },
  '\\ddots': { snippet: '\\ddots', description: 'Diagonal dots', category: 'math-dots' },
  '\\ldots': { snippet: '\\ldots', description: 'Low dots', category: 'math-dots' },

  // Math - logic
  '\\forall': { snippet: '\\forall', description: 'For all', category: 'math-logic' },
  '\\exists': { snippet: '\\exists', description: 'There exists', category: 'math-logic' },
  '\\nexists': { snippet: '\\nexists', description: 'There does not exist', category: 'math-logic' },
  '\\neg': { snippet: '\\neg', description: 'Not', category: 'math-logic' },
  '\\wedge': { snippet: '\\wedge', description: 'And (wedge)', category: 'math-logic' },
  '\\vee': { snippet: '\\vee', description: 'Or (vee)', category: 'math-logic' },
  '\\therefore': { snippet: '\\therefore', description: 'Therefore', category: 'math-logic' },
  '\\because': { snippet: '\\because', description: 'Because', category: 'math-logic' },
  '\\qed': { snippet: '\\qed', description: 'End of proof', category: 'math-logic' },

  // Math - sets
  '\\emptyset': { snippet: '\\emptyset', description: 'Empty set', category: 'math-sets' },
  '\\varnothing': { snippet: '\\varnothing', description: 'Empty set (variant)', category: 'math-sets' },
  '\\in': { snippet: '\\in', description: 'Element of', category: 'math-sets' },
  '\\notin': { snippet: '\\notin', description: 'Not element of', category: 'math-sets' },
  '\\ni': { snippet: '\\ni', description: 'Contains as member', category: 'math-sets' },
  '\\cup': { snippet: '\\cup', description: 'Union', category: 'math-sets' },
  '\\cap': { snippet: '\\cap', description: 'Intersection', category: 'math-sets' },
  '\\setminus': { snippet: '\\setminus', description: 'Set difference', category: 'math-sets' },
  '\\subset': { snippet: '\\subset', description: 'Proper subset', category: 'math-sets' },
  '\\supset': { snippet: '\\supset', description: 'Proper superset', category: 'math-sets' },
  '\\subseteq': { snippet: '\\subseteq', description: 'Subset or equal', category: 'math-sets' },
  '\\supseteq': { snippet: '\\supseteq', description: 'Superset or equal', category: 'math-sets' },
  '\\mathbb{R}': { snippet: '\\mathbb{${1:R}}', description: 'Blackboard bold', category: 'math-sets' },

  // Math - misc
  '\\infty': { snippet: '\\infty', description: 'Infinity', category: 'math-misc' },
  '\\partial': { snippet: '\\partial', description: 'Partial derivative', category: 'math-misc' },
  '\\nabla': { snippet: '\\nabla', description: 'Nabla (del)', category: 'math-misc' },
  '\\hbar': { snippet: '\\hbar', description: 'Planck constant h-bar', category: 'math-misc' },
  '\\ell': { snippet: '\\ell', description: 'Script ell', category: 'math-misc' },
  '\\Re': { snippet: '\\Re', description: 'Real part', category: 'math-misc' },
  '\\Im': { snippet: '\\Im', description: 'Imaginary part', category: 'math-misc' },
  '\\angle': { snippet: '\\angle', description: 'Angle', category: 'math-misc' },
  '\\triangle': { snippet: '\\triangle', description: 'Triangle', category: 'math-misc' },
  '\\square': { snippet: '\\square', description: 'Square', category: 'math-misc' },
  '\\diamond': { snippet: '\\diamond', description: 'Diamond', category: 'math-misc' },
  '\\star': { snippet: '\\star', description: 'Star', category: 'math-misc' },
  '\\times': { snippet: '\\times', description: 'Times (multiplication)', category: 'math-misc' },
  '\\div': { snippet: '\\div', description: 'Division', category: 'math-misc' },
  '\\pm': { snippet: '\\pm', description: 'Plus-minus', category: 'math-misc' },
  '\\mp': { snippet: '\\mp', description: 'Minus-plus', category: 'math-misc' },
  '\\circ': { snippet: '\\circ', description: 'Circle (composition)', category: 'math-misc' },
  '\\bullet': { snippet: '\\bullet', description: 'Bullet', category: 'math-misc' },
  '\\oplus': { snippet: '\\oplus', description: 'Direct sum', category: 'math-misc' },
  '\\otimes': { snippet: '\\otimes', description: 'Tensor product', category: 'math-misc' },
  '\\odot': { snippet: '\\odot', description: 'Circle dot', category: 'math-misc' },

  // Document structure
  '\\section': { snippet: '\\section{${1:title}}', description: 'Section', category: 'document' },
  '\\subsection': { snippet: '\\subsection{${1:title}}', description: 'Subsection', category: 'document' },
  '\\subsubsection': { snippet: '\\subsubsection{${1:title}}', description: 'Subsubsection', category: 'document' },
  '\\paragraph': { snippet: '\\paragraph{${1:title}}', description: 'Paragraph heading', category: 'document' },
  '\\part': { snippet: '\\part{${1:title}}', description: 'Part', category: 'document' },
  '\\chapter': { snippet: '\\chapter{${1:title}}', description: 'Chapter', category: 'document' },

  // References
  '\\label': { snippet: '\\label{${1:key}}', description: 'Label', category: 'references' },
  '\\ref': { snippet: '\\ref{${1:key}}', description: 'Reference', category: 'references' },
  '\\pageref': { snippet: '\\pageref{${1:key}}', description: 'Page reference', category: 'references' },
  '\\eqref': { snippet: '\\eqref{${1:key}}', description: 'Equation reference', category: 'references' },
  '\\cite': { snippet: '\\cite{${1:key}}', description: 'Citation', category: 'references' },
  '\\citep': { snippet: '\\citep{${1:key}}', description: 'Parenthetical citation', category: 'references' },
  '\\citet': { snippet: '\\citet{${1:key}}', description: 'Textual citation', category: 'references' },

  // Links
  '\\href': { snippet: '\\href{${1:url}}{${2:text}}', description: 'Hyperlink', category: 'links' },
  '\\url': { snippet: '\\url{${1:url}}', description: 'URL', category: 'links' },
  '\\hyperlink': { snippet: '\\hyperlink{${1:target}}{${2:text}}', description: 'Internal hyperlink', category: 'links' },
  '\\hypertarget': { snippet: '\\hypertarget{${1:label}}{${2:text}}', description: 'Hyperlink target', category: 'links' },

  // Spacing
  '\\quad': { snippet: '\\quad', description: 'Quad space (1em)', category: 'spacing' },
  '\\qquad': { snippet: '\\qquad', description: 'Double quad space (2em)', category: 'spacing' },
  '\\hspace': { snippet: '\\hspace{${1:length}}', description: 'Horizontal space', category: 'spacing' },
  '\\vspace': { snippet: '\\vspace{${1:length}}', description: 'Vertical space', category: 'spacing' },
  '\\smallskip': { snippet: '\\smallskip', description: 'Small vertical space', category: 'spacing' },
  '\\medskip': { snippet: '\\medskip', description: 'Medium vertical space', category: 'spacing' },
  '\\bigskip': { snippet: '\\bigskip', description: 'Large vertical space', category: 'spacing' },
  '\\newline': { snippet: '\\\\', description: 'New line', category: 'spacing' },
  '\\newpage': { snippet: '\\newpage', description: 'New page', category: 'spacing' },
  '\\clearpage': { snippet: '\\clearpage', description: 'Clear page and floats', category: 'spacing' },

  // Special characters
  '\\#': { snippet: '\\#', description: 'Hash symbol', category: 'special' },
  '\\$': { snippet: '\\$', description: 'Dollar sign', category: 'special' },
  '\\%': { snippet: '\\%', description: 'Percent sign', category: 'special' },
  '\\&': { snippet: '\\&', description: 'Ampersand', category: 'special' },
  '\\_': { snippet: '\\_', description: 'Underscore', category: 'special' },
  '\\{': { snippet: '\\{', description: 'Left brace', category: 'special' },
  '\\}': { snippet: '\\}', description: 'Right brace', category: 'special' },
  '\\textbackslash': { snippet: '\\textbackslash', description: 'Backslash in text', category: 'special' },
  '\\textasciitilde': { snippet: '\\textasciitilde', description: 'Tilde in text', category: 'special' },
  '\\textasciicircum': { snippet: '\\textasciicircum', description: 'Circumflex in text', category: 'special' },

  // Environments
  '\\begin': { snippet: '\\begin{${1:environment}}\n  ${2:content}\n\\end{${1:environment}}', description: 'Begin environment', category: 'environments' },
  '\\end': { snippet: '\\end{${1:environment}}', description: 'End environment', category: 'environments' },

  // Packages
  '\\usepackage': { snippet: '\\usepackage[${1:options}]{${2:package}}', description: 'Use package', category: 'packages' },
  '\\documentclass': { snippet: '\\documentclass[${1:options}]{${2:class}}', description: 'Document class', category: 'packages' },
  '\\newcommand': { snippet: '\\newcommand{\\${1:name}}[${2:0}]{${3:definition}}', description: 'Define new command', category: 'packages' },
  '\\renewcommand': { snippet: '\\renewcommand{\\${1:name}}[${2:0}]{${3:definition}}', description: 'Redefine command', category: 'packages' },
  '\\providecommand': { snippet: '\\providecommand{\\${1:name}}[${2:0}]{${3:definition}}', description: 'Provide command (if not defined)', category: 'packages' },

  // Tables
  '\\begin{tabular}': { snippet: '\\begin{tabular}{${1:ccc}}\n  ${2:Header 1} & ${3:Header 2} & ${4:Header 3} \\\\\n  \\hline\n  ${5:Row 1} & ${6:Data} & ${7:Data} \\\\\n\\end{tabular}', description: 'Tabular environment', category: 'tables' },
  '\\hline': { snippet: '\\hline', description: 'Horizontal line in table', category: 'tables' },
  '\\toprule': { snippet: '\\toprule', description: 'Top rule (booktabs)', category: 'tables' },
  '\\midrule': { snippet: '\\midrule', description: 'Mid rule (booktabs)', category: 'tables' },
  '\\bottomrule': { snippet: '\\bottomrule', description: 'Bottom rule (booktabs)', category: 'tables' },

  // Figures
  '\\includegraphics': { snippet: '\\includegraphics[${1:width=\\textwidth}]{${2:filename}}', description: 'Include graphics', category: 'figures' },
  '\\caption': { snippet: '\\caption{${1:description}}', description: 'Figure/table caption', category: 'figures' },
  '\\label{fig:}': { snippet: '\\label{fig:${1:name}}', description: 'Figure label', category: 'figures' },
};

export class CompletionEngine {
  constructor() {
    this._index = this._buildIndex();
    this.customCommands = new Map();
  }

  _buildIndex() {
    const index = { byPrefix: new Map(), byCategory: new Map() };

    for (const [cmd, info] of Object.entries(COMMANDS)) {
      // Index by prefix (first 2+ characters)
      for (let len = 2; len <= cmd.length; len++) {
        const prefix = cmd.slice(0, len);
        if (!index.byPrefix.has(prefix)) {
          index.byPrefix.set(prefix, []);
        }
        index.byPrefix.get(prefix).push({ command: cmd, ...info });
      }

      // Index by category
      if (!index.byCategory.has(info.category)) {
        index.byCategory.set(info.category, []);
      }
      index.byCategory.get(info.category).push({ command: cmd, ...info });
    }

    return index;
  }

  /**
   * Get completions for a given prefix.
   */
  getCompletions(prefix, options = {}) {
    const results = [];
    const maxResults = options.maxResults || 20;

    // Match against built-in commands
    for (let len = prefix.length; len >= 2; len--) {
      const subPrefix = prefix.slice(0, len);
      const matches = this._index.byPrefix.get(subPrefix);
      if (matches) {
        for (const match of matches) {
          if (!results.some(r => r.command === match.command)) {
            results.push(match);
          }
        }
      }
      if (results.length >= maxResults) break;
    }

    // Match against custom commands
    for (const [cmd, info] of this.customCommands) {
      if (cmd.startsWith(prefix)) {
        results.push({ command: cmd, ...info });
      }
    }

    // Fuzzy match if no prefix matches
    if (results.length === 0 && prefix.length >= 2) {
      for (const [cmd, info] of Object.entries(COMMANDS)) {
        if (this._fuzzyMatch(cmd, prefix)) {
          results.push({ command: cmd, ...info });
        }
        if (results.length >= maxResults) break;
      }
    }

    return results.slice(0, maxResults);
  }

  /**
   * Get completions for an environment name.
   */
  getEnvironmentCompletions(prefix = '') {
    const allEnvs = new Set([
      ...MATH_ENVIRONMENTS,
      ...TEXT_ENVIRONMENTS,
      ...FLOAT_ENVIRONMENTS,
      'document', 'theorem', 'lemma', 'proof', 'definition',
      'remark', 'example', 'corollary', 'proposition',
      'axiom', 'conjecture', 'abstract', 'titlepage',
    ]);

    const results = [];
    for (const env of allEnvs) {
      if (!prefix || env.startsWith(prefix)) {
        results.push({ name: env, category: this._getEnvCategory(env) });
      }
    }
    return results.sort((a, b) => a.name.localeCompare(b.name));
  }

  _getEnvCategory(name) {
    if (MATH_ENVIRONMENTS.has(name)) return 'math';
    if (TEXT_ENVIRONMENTS.has(name)) return 'text';
    if (FLOAT_ENVIRONMENTS.has(name)) return 'float';
    return 'structural';
  }

  /**
   * Get all commands in a category.
   */
  getCommandsByCategory(category) {
    return this._index.byCategory.get(category) || [];
  }

  /**
   * Get all available categories.
   */
  getCategories() {
    return Array.from(this._index.byCategory.keys()).sort();
  }

  /**
   * Register a custom command.
   */
  registerCommand(name, snippet, description, category = 'custom') {
    this.customCommands.set(name, { snippet, description, category });
  }

  /**
   * Get command info.
   */
  getCommandInfo(name) {
    return COMMANDS[name] || this.customCommands.get(name) || null;
  }

  /**
   * Get all commands.
   */
  getAllCommands() {
    return Object.entries(COMMANDS).map(([cmd, info]) => ({ command: cmd, ...info }));
  }

  _fuzzyMatch(str, pattern) {
    let pi = 0;
    for (let si = 0; si < str.length && pi < pattern.length; si++) {
      if (str[si].toLowerCase() === pattern[pi].toLowerCase()) pi++;
    }
    return pi === pattern.length;
  }
}

/**
 * Convenience: get completions for a prefix.
 */
export function getLatexCompletions(prefix, options = {}) {
  const engine = new CompletionEngine();
  return engine.getCompletions(prefix, options);
}
