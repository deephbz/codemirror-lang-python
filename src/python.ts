import {parser} from "@lezer/python"
import {SyntaxNode, Tree} from "@lezer/common"
import {delimitedIndent, indentNodeProp, TreeIndentContext, 
        foldNodeProp, foldInside, LRLanguage, LanguageSupport} from "@codemirror/language"
import {globalCompletion, localCompletionSource} from "./complete"
export {globalCompletion, localCompletionSource}

type NodeType = 'Body' | 'MatchBody' | 'Comment' | 'MatchClause' | 'Statement'

interface IndentationState {
  node: SyntaxNode
  pos: number
  found: SyntaxNode | null
}

// Predicate functions for node types
const isBody = (node: SyntaxNode): boolean => 
  node.name === 'Body' || node.name === 'MatchBody'

const isComment = (node: SyntaxNode): boolean => 
  node.name === 'Comment'

const isMatchClause = (node: SyntaxNode): boolean =>
  node.name === 'MatchClause'

const isStatement = (node: SyntaxNode): boolean =>
  node.type.is("Statement")

// Pure function to process a single node in the tree traversal
function processNode(state: IndentationState, context: TreeIndentContext): IndentationState {
  const {node, pos} = state
  const before = node.childBefore(pos)
  
  if (!before) return state
  
  const lineIndent = context.lineIndent(pos, -1)
  const baseIndent = context.baseIndentFor(before) + context.unit

  if (isComment(before)) {
    return {...state, pos: before.from}
  }
  
  if (isBody(before) && baseIndent <= lineIndent) {
    return {
      node: before,
      pos: pos,
      found: before
    }
  }
  
  if (isMatchClause(before) || isStatement(before)) {
    return {
      node: before,
      pos: pos,
      found: state.found
    }
  }
  
  return state
}

function innerBody(context: TreeIndentContext) {
  let state: IndentationState = {
    node: context.node,
    pos: context.pos,
    found: null
  }

  // Process nodes until we can't anymore
  while (true) {
    const newState = processNode(state, context)
    if (newState === state) break
    state = newState
  }

  return state.found
}

function indentBody(context: TreeIndentContext, node: SyntaxNode) {
  let base = context.baseIndentFor(node)
  let line = context.lineAt(context.pos, -1), to = line.from + line.text.length
  // Don't consider blank, deindented lines at the end of the
  // block part of the block
  if (/^\s*($|#)/.test(line.text) &&
      context.node.to < to + 100 &&
      !/\S/.test(context.state.sliceDoc(to, context.node.to)) &&
      context.lineIndent(context.pos, -1) <= base)
    return null
  // A normally deindenting keyword that appears at a higher
  // indentation than the block should probably be handled by the next
  // level
  if (/^\s*(else:|elif |except |finally:|case\s+[^=:]+:)/.test(context.textAfter) && context.lineIndent(context.pos, -1) > base)
    return null
  return base + context.unit
}

/// A language provider based on the [Lezer Python
/// parser](https://github.com/lezer-parser/python), extended with
/// highlighting and indentation information.
export const pythonLanguage = LRLanguage.define({
  name: "python",
  parser: parser.configure({
    props: [
      indentNodeProp.add({
        Body: context => {
          let inner = innerBody(context)
          return indentBody(context, inner || context.node) ?? context.continue()
        },

        MatchBody: context => {
          let inner = innerBody(context)
          return indentBody(context, inner || context.node) ?? context.continue()
        },

        IfStatement: cx => /^\s*(else:|elif )/.test(cx.textAfter) ? cx.baseIndent : cx.continue(),
        "ForStatement WhileStatement": cx => /^\s*else:/.test(cx.textAfter) ? cx.baseIndent : cx.continue(),
        TryStatement: cx => /^\s*(except |finally:|else:)/.test(cx.textAfter) ? cx.baseIndent : cx.continue(),
        MatchStatement: cx => {
          if (/^\s*case /.test(cx.textAfter)) return cx.baseIndent + cx.unit
          return cx.continue()
        },

        "TupleExpression ComprehensionExpression ParamList ArgList ParenthesizedExpression": delimitedIndent({closing: ")"}),
        "DictionaryExpression DictionaryComprehensionExpression SetExpression SetComprehensionExpression": delimitedIndent({closing: "}"}),
        "ArrayExpression ArrayComprehensionExpression": delimitedIndent({closing: "]"}),
        "String FormatString": () => null,
        Script: context => {
          let inner = innerBody(context)
          return (inner && indentBody(context, inner)) ?? context.continue()
        }
      }),

      foldNodeProp.add({
        "ArrayExpression DictionaryExpression SetExpression TupleExpression": foldInside,
        Body: (node, state) => ({from: node.from + 1, to: node.to - (node.to == state.doc.length ? 0 : 1)})
      })
    ],
  }),
  languageData: {
    closeBrackets: {
      brackets: ["(", "[", "{", "'", '"', "'''", '"""'],
      stringPrefixes: ["f", "fr", "rf", "r", "u", "b", "br", "rb",
                       "F", "FR", "RF", "R", "U", "B", "BR", "RB"]
    },
    commentTokens: {line: "#"},
    // Indent logic logic are triggered upon below input patterns
    indentOnInput: /^\s*([\}\]\)]|else:|elif |except |finally:|case\s+[^:]*:?)$/,
  }
})

/// Python language support.
export function python() {
  return new LanguageSupport(pythonLanguage, [
    pythonLanguage.data.of({autocomplete: localCompletionSource}),
    pythonLanguage.data.of({autocomplete: globalCompletion}),
  ])
}
