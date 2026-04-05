// www/js/latex/packages/amsmath.js
// AMS math extensions: extended operators, text in math, etc.

export const AMS_COMMANDS = {
  '\\iint': '\\int\\!\\!\\!\\int',
  '\\iiint': '\\int\\!\\!\\!\\int\\!\\!\\!\\int',
  '\\iiiint': '\\int\\!\\!\\!\\int\\!\\!\\!\\int\\!\\!\\!\\int',
  '\\idotsint': '\\int\\!\\cdots\\!\\int',
  '\\text': '__AMS_TEXT__',
  '\\intertext': '__AMS_INTERTEXT__',
  '\\shortintertext': '__AMS_SHORTINTERTEXT__',
  '\\overset': '__AMS_OVERSET__',
  '\\underset': '__AMS_UNDERSET__',
  '\\sideset': '__AMS_SIDESET__',
  '\\genfrac': '__AMS_GENFRAC__',
  '\\binom': '{#1 \\choose #2}',
  '\\tbinom': '{#1 \\choose #2}',
  '\\dbinom': '{#1 \\choose #2}',
  '\\smash': '__AMS_SMASH__',
  '\\mathclap': '__AMS_MATHCLAP__',
  '\\mathllap': '__AMS_MATHLLAP__',
  '\\mathrlap': '__AMS_MATHRLAP__',
  '\\DeclareMathOperator': '__AMS_DECLMOP__',
  '\\operatorname': '__AMS_OPERATORNAME__',
  '\\varinjlim': '\\mathop{\\underrightarrow{\\rm lim}}',
  '\\varprojlim': '\\mathop{\\underleftarrow{\\rm lim}}',
  '\\varlimsup': '\\mathop{\\overline{\\rm lim}}',
  '\\varliminf': '\\mathop{\\underline{\\rm lim}}',
  '\\doteqdot': '\\doteq',
  '\\risingdotseq': '\\doteq',
  '\\fallingdotseq': '\\doteq',
  '\\coloneqq': ':=',
  '\\eqqcolon': '=:',
  '\\coloneq': ':=',
  '\\eqcolon': '=:',
  '\\arrowvert': '|',
  '\\Arrowvert': '\\|',
  '\\bracevert': '|',
  '\\vert': '|',
  '\\Vert': '\\|',
  '\\lvert': '|',
  '\\rvert': '|',
  '\\lVert': '\\|',
  '\\rVert': '\\|',
  '\\lgroup': '(',
  '\\rgroup': ')',
  '\\iff': '\\;\\Longleftrightarrow\\;',
  '\\implies': '\\;\\Longrightarrow\\;',
  '\\impliedby': '\\;\\Longleftarrow\\;',
  '\\colon': ':\\,',
  '\\nobreakdash': '',
  '\\varGamma': '\\Gamma',
  '\\varDelta': '\\Delta',
  '\\varTheta': '\\Theta',
  '\\varLambda': '\\Lambda',
  '\\varXi': '\\Xi',
  '\\varPi': '\\Pi',
  '\\varSigma': '\\Sigma',
  '\\varUpsilon': '\\Upsilon',
  '\\varPhi': '\\Phi',
  '\\varPsi': '\\Psi',
  '\\varOmega': '\\Omega',
  '\\varvarepsilon': '\\varepsilon',
  '\\varuparrow': '\\uparrow',
  '\\varUparrow': '\\Uparrow',
  '\\varupdownarrow': '\\updownarrow',
  '\\varUpdownarrow': '\\Updownarrow',
  '\\varhookrightarrow': '\\hookrightarrow',
  '\\varhookleftarrow': '\\hookleftarrow',
  '\\varlongleftarrow': '\\longleftarrow',
  '\\varlongrightarrow': '\\longrightarrow',
  '\\varlongleftrightarrow': '\\longleftrightarrow',
  '\\varLongleftarrow': '\\Longleftarrow',
  '\\varLongrightarrow': '\\Longrightarrow',
  '\\varLongleftrightarrow': '\\Longleftrightarrow',
  '\\varmapsto': '\\mapsto',
  '\\varlongmapsto': '\\longmapsto',
  '\\varhookmapsto': '\\hookmapsto',
};

export function processAmsMath(source) {
  let result = source;
  for (const [cmd, replacement] of Object.entries(AMS_COMMANDS)) {
    if (result.includes(cmd)) {
      result = result.split(cmd).join(replacement);
    }
  }
  result = result.replace(/__(?:AMS_[A-Z_]+)__/g, '');
  return result;
}

export function getAmsCommands() {
  return Object.keys(AMS_COMMANDS);
}

export function isAmsCommand(name) {
  return name in AMS_COMMANDS;
}
