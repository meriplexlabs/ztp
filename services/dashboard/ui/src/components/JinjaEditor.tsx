import CodeMirror from '@uiw/react-codemirror'
import { StreamLanguage } from '@codemirror/language'
import { autocompletion, type CompletionContext } from '@codemirror/autocomplete'
import { oneDark } from '@codemirror/theme-one-dark'

// ── Jinja2 stream language ─────────────────────────────────────────────────────

type JinjaState = { mode: 'text' | 'tag' | 'var' | 'comment' }

const JINJA_KEYWORDS = [
  'if', 'else', 'elif', 'endif',
  'for', 'endfor', 'recursive',
  'block', 'endblock', 'extends', 'super',
  'include', 'import', 'from', 'as',
  'macro', 'endmacro', 'call', 'endcall',
  'filter', 'endfilter',
  'set', 'do', 'with', 'endwith',
  'raw', 'endraw', 'without', 'context',
  'not', 'and', 'or', 'in', 'is', 'none', 'true', 'false',
  'loop', 'namespace',
]

const jinjaLanguage = StreamLanguage.define<JinjaState>({
  startState: () => ({ mode: 'text' }),

  token(stream, state) {
    if (state.mode === 'comment') {
      if (stream.match('#}')) { state.mode = 'text'; return 'comment' }
      stream.next()
      return 'comment'
    }

    if (state.mode === 'tag') {
      if (stream.match('%}')) { state.mode = 'text'; return 'meta' }
      if (stream.eatSpace()) return null
      if (stream.match(/^-?\s*/)) return null
      const kw = stream.match(/^[a-z_]+/)
      if (kw && kw !== true) {
        return JINJA_KEYWORDS.includes(kw[0]) ? 'keyword' : 'variableName'
      }
      if (stream.match(/^["'](?:[^"'\\]|\\.)*["']/)) return 'string'
      if (stream.match(/^\d+/)) return 'number'
      if (stream.match(/^[|.,:()[\]{}+\-*/%=!<>~]/)) return 'operator'
      stream.next()
      return null
    }

    if (state.mode === 'var') {
      if (stream.match('}}')) { state.mode = 'text'; return 'meta' }
      if (stream.eatSpace()) return null
      if (stream.match(/^[a-zA-Z_][\w.]*/)) return 'variableName'
      if (stream.match(/^["'](?:[^"'\\]|\\.)*["']/)) return 'string'
      if (stream.match(/^[|.,:()[\]{}+\-*/%=!<>~]/)) return 'operator'
      stream.next()
      return null
    }

    // text mode
    if (stream.match('{#')) { state.mode = 'comment'; return 'comment' }
    if (stream.match('{%-') || stream.match('{%')) { state.mode = 'tag'; return 'meta' }
    if (stream.match('{{-') || stream.match('{{')) { state.mode = 'var'; return 'meta' }

    while (stream.next() !== null) {
      if (stream.peek() === '{') break
    }
    return null
  },

  copyState: s => ({ mode: s.mode }),
  blankLine(state) { state.mode = 'text' },
})

// ── Jinja2 autocomplete ────────────────────────────────────────────────────────

const TAG_SNIPPETS = [
  { label: 'if',       apply: '{% if  %}\n{% endif %}',       detail: 'if block' },
  { label: 'for',      apply: '{% for  in  %}\n{% endfor %}', detail: 'for loop' },
  { label: 'block',    apply: '{% block  %}\n{% endblock %}', detail: 'template block' },
  { label: 'extends',  apply: "{% extends '' %}",             detail: 'template inheritance' },
  { label: 'include',  apply: "{% include '' %}",             detail: 'include template' },
  { label: 'set',      apply: '{% set  =  %}',                detail: 'set variable' },
  { label: 'macro',    apply: '{% macro () %}\n{% endmacro %}', detail: 'define macro' },
  { label: 'elif',     apply: '{% elif  %}',                  detail: 'else if' },
  { label: 'else',     apply: '{% else %}',                   detail: 'else' },
  { label: 'endif',    apply: '{% endif %}',                  detail: 'end if' },
  { label: 'endfor',   apply: '{% endfor %}',                 detail: 'end for' },
  { label: 'endblock', apply: '{% endblock %}',               detail: 'end block' },
]

const KW_OPTIONS = JINJA_KEYWORDS.map(k => ({ label: k, type: 'keyword' }))

function jinjaCompletions(ctx: CompletionContext) {
  // inside {%  %} — offer tag snippets and keywords
  const tagMatch = ctx.matchBefore(/\{%-?\s*\w*/)
  if (tagMatch) {
    return {
      from: tagMatch.from,
      options: TAG_SNIPPETS.map(s => ({ ...s, type: 'function' })),
    }
  }

  // inside {{  }} — offer keyword completions
  const varMatch = ctx.matchBefore(/\{\{-?\s*\w+/)
  if (varMatch) {
    return { from: varMatch.from, options: KW_OPTIONS }
  }

  // typing a bare word inside an already-open tag context
  const word = ctx.matchBefore(/\w+/)
  if (!word || (word.from === word.to && !ctx.explicit)) return null
  return { from: word.from, options: KW_OPTIONS }
}

// ── Component ──────────────────────────────────────────────────────────────────

interface JinjaEditorProps {
  value: string
  onChange: (v: string) => void
  minHeight?: string
  placeholder?: string
}

export default function JinjaEditor({
  value,
  onChange,
  minHeight = '24rem',
  placeholder,
}: JinjaEditorProps) {
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      theme={oneDark}
      placeholder={placeholder}
      extensions={[
        jinjaLanguage,
        autocompletion({ override: [jinjaCompletions], defaultKeymap: true }),
      ]}
      basicSetup={{
        lineNumbers: true,
        foldGutter: false,
        highlightActiveLine: true,
        highlightSelectionMatches: true,
        tabSize: 2,
      }}
      style={{ minHeight, fontSize: '0.75rem' }}
      className="border rounded overflow-hidden focus-within:ring-2 focus-within:ring-primary/50"
    />
  )
}
