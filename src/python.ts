import {parser} from "@lezer/python"
import {SyntaxNode} from "@lezer/common"
import {
  delimitedIndent,
  indentNodeProp,
  TreeIndentContext,
  foldNodeProp,
  foldInside,
  LRLanguage,
  LanguageSupport
} from "@codemirror/language"
import {globalCompletion, localCompletionSource} from "./complete"

export {globalCompletion, localCompletionSource}

/**
 * Searches backward in the syntax tree from the current position to find
 * a containing 'Body' or 'MatchBody' node whose indentation scope may
 * control how we indent.
 *
 * The original logic skipped over comments, recognized 'Body' or 'MatchBody',
 * and stopped on encountering nodes that should not be traversed further.
 */
function findRelevantBody(context: TreeIndentContext): SyntaxNode | null {
  const {node, pos} = context
  const lineIndent = context.lineIndent(pos, -1)

  function recurse(currentNode: SyntaxNode, at: number, found: SyntaxNode | null): SyntaxNode | null {
    const before = currentNode.childBefore(at)
    if (!before) return found

    switch (before.name) {
      case "Comment":
        // Skip comments; keep searching backward
        return recurse(currentNode, before.from, found)

      case "Body":
      case "MatchBody":
        // If this Body/MatchBody indentation is less/equal to this line,
        // we record it as potentially relevant for indentation.
        if (context.baseIndentFor(before) + context.unit <= lineIndent) {
          found = before
        }
        // Then continue from inside the newly encountered node
        return recurse(before, at, found)

      case "MatchClause":
        // Just move into the MatchClause node
        return recurse(before, at, found)

      default:
        // If we are still in a statement, keep going,
        // else stop and return whatever was found
        if (before.type.is("Statement")) {
          return recurse(before, at, found)
        }
        return found
    }
  }

  return recurse(node, pos, null)
}

/**
 * Returns a suitable indent for code within the given `Body` or `MatchBody`,
 * or `null` if we should not directly modify indentation.
 *
 * This extracts and clarifies the logic for:
 *   - Skipping indent on blank or comment-only lines near the end of a block
 *   - Avoiding conflicts with keywords that cause deindentation
 */
function indentBodyNode(context: TreeIndentContext, bodyNode: SyntaxNode): number | null {
  const baseIndent = context.baseIndentFor(bodyNode)
  const line = context.lineAt(context.pos, -1)
  const to = line.from + line.text.length

  // 1) If it’s a blank or comment line at the end of the body,
  //    and it’s not already indented beyond `baseIndent`, leave it alone.
  const lineIsBlankOrComment = /^\s*(?:$|#)/.test(line.text)
  const nearBlockEnd = context.node.to < to + 100
  const noFurtherText = !/\S/.test(context.state.sliceDoc(to, context.node.to))
  const currentLineIndent = context.lineIndent(context.pos, -1)

  if (
    lineIsBlankOrComment &&
    nearBlockEnd &&
    noFurtherText &&
    currentLineIndent <= baseIndent
  ) {
    return null
  }

  // 2) Certain keywords that normally end blocks (else, elif, except, finally, case)
  //    cause deindentation. If they're more indented than `baseIndent`, defer to next context.
  const deindentKeywords = /^\s*(else:|elif |except |finally:|case\s+[^=:]+:)/
  if (deindentKeywords.test(context.textAfter) && currentLineIndent > baseIndent) {
    return null
  }

  // Otherwise, indent by one unit beyond the base block indent.
  return baseIndent + context.unit
}

/**
 * Computes indentation for 'Body' or 'MatchBody' nodes by searching
 * for a relevant containing block and deriving an indent from it.
 * Falls back to normal `context.continue()` if none applies.
 */
function indentBody(context: TreeIndentContext) {
  const relevantBody = findRelevantBody(context)
  if (relevantBody) {
    const indent = indentBodyNode(context, relevantBody)
    if (indent !== null) return indent
  }
  return context.continue()
}

/**
 * A language provider based on the Lezer Python parser, extended
 * with highlighting and indentation information.
 */
export const pythonLanguage = LRLanguage.define({
  name: "python",
  parser: parser.configure({
    props: [
      indentNodeProp.add({
        // Indentation logic for block structures
        Body: indentBody,
        MatchBody: indentBody,

        // Compound statements that deindent on matching keywords
        IfStatement: cx => /^\s*(else:|elif )/.test(cx.textAfter) ? cx.baseIndent : cx.continue(),
        "ForStatement WhileStatement": cx => /^\s*else:/.test(cx.textAfter) ? cx.baseIndent : cx.continue(),
        TryStatement: cx => /^\s*(except |finally:|else:)/.test(cx.textAfter) ? cx.baseIndent : cx.continue(),
        MatchStatement: cx => {
          if (/^\s*case /.test(cx.textAfter)) {
            // 'case' lines are one indent deeper than match
            return cx.baseIndent + cx.unit
          }
          return cx.continue()
        },

        // For bracket-delimited constructs, rely on the built-in delimited indentation
        "TupleExpression ComprehensionExpression ParamList ArgList ParenthesizedExpression":
          delimitedIndent({closing: ")"}),
        "DictionaryExpression DictionaryComprehensionExpression SetExpression SetComprehensionExpression":
          delimitedIndent({closing: "}"}),
        "ArrayExpression ArrayComprehensionExpression":
          delimitedIndent({closing: "]"}),

        // String-likes: no custom indentation
        "String FormatString": () => null,

        // Top-level script logic
        Script: context => {
          const body = findRelevantBody(context)
          if (body) {
            const indent = indentBodyNode(context, body)
            if (indent !== null) return indent
          }
          return context.continue()
        }
      }),

      foldNodeProp.add({
        // Similar to the existing code
        "ArrayExpression DictionaryExpression SetExpression TupleExpression": foldInside,
        Body: (node, state) => ({
          from: node.from + 1,
          to: node.to - (node.to === state.doc.length ? 0 : 1)
        })
      })
    ]
  }),
  languageData: {
    closeBrackets: {
      brackets: ["(", "[", "{", "'", '"', "'''", '"""'],
      stringPrefixes: [
        "f", "fr", "rf", "r", "u", "b", "br", "rb",
        "F", "FR", "RF", "R", "U", "B", "BR", "RB"
      ]
    },
    commentTokens: {line: "#"},
    // Matches keywords or brackets that typically adjust indentation
    indentOnInput: /^\s*([\}\]\)]|else:|elif |except |finally:|case\s+[^:]*:?)$/
  }
})

/**
 * Python language support extension, combining the parser + indentation
 * + autocompletion.
 */
export function python() {
  return new LanguageSupport(pythonLanguage, [
    pythonLanguage.data.of({autocomplete: localCompletionSource}),
    pythonLanguage.data.of({autocomplete: globalCompletion}),
  ])
}