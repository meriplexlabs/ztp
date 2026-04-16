import { useCallback, useEffect, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { StreamLanguage } from '@codemirror/language'
import { autocompletion, type CompletionContext } from '@codemirror/autocomplete'
import { oneDark } from '@codemirror/theme-one-dark'

// ── Jinja2 stream language ─────────────────────────────────────────────────────

type JinjaMode = 'text' | 'tag' | 'var' | 'comment'
type JinjaState = { mode: JinjaMode }

const JINJA_KEYWORDS = [
  'if', 'else', 'elif', 'endif',
  'for', 'endfor', 'recursive',
  'block', 'endblock', 'extends', 'super',
  'include', 'import', 'from', 'as',
  'macro', 'endmacro', 'call', 'endcall',
  'filter', 'endfilter',
  'set', 'do', 'with', 'endwith',
  'raw', 'endraw', 'not', 'and', 'or',
  'in', 'is', 'none', 'true', 'false', 'loop', 'namespace',
]

const jinjaLanguage = StreamLanguage.define<JinjaState>({
  startState: (): JinjaState => ({ mode: 'text' }),
  copyState: (s): JinjaState => ({ mode: s.mode }),
  blankLine(state) { state.mode = 'text' },

  token(stream, state): string | null {
    if (state.mode === 'comment') {
      if (stream.match('#}')) { state.mode = 'text'; return 'comment' }
      stream.next()
      return 'comment'
    }

    if (state.mode === 'tag') {
      if (stream.match(/%}/)) { state.mode = 'text'; return 'meta' }
      if (stream.eatSpace()) return null
      const kw = stream.match(/^-?[a-z_]+/)
      if (kw !== true && kw) {
        return JINJA_KEYWORDS.includes(kw[0]) ? 'keyword' : 'variableName'
      }
      if (stream.match(/^["'](?:[^"'\\]|\\.)*["']/)) return 'string'
      if (stream.match(/^\d+/)) return 'number'
      if (stream.match(/^[|.,:()[\]{}+\-*/%=!<>~-]/)) return 'operator'
      stream.next()
      return null
    }

    if (state.mode === 'var') {
      if (stream.match(/}}/)) { state.mode = 'text'; return 'meta' }
      if (stream.eatSpace()) return null
      if (stream.match(/^[a-zA-Z_][\w.]*/)) return 'variableName'
      if (stream.match(/^["'](?:[^"'\\]|\\.)*["']/)) return 'string'
      if (stream.match(/^[|.,:()[\]{}+\-*/%=!<>~-]/)) return 'operator'
      stream.next()
      return null
    }

    // text mode
    if (stream.match('{#')) { state.mode = 'comment'; return 'comment' }
    if (stream.match(/^\{%-?/)) { state.mode = 'tag'; return 'meta' }
    if (stream.match(/^\{\{-?/)) { state.mode = 'var'; return 'meta' }

    while (stream.next() !== null) {
      if (stream.peek() === '{') break
    }
    return null
  },
})

// ── Autocomplete ───────────────────────────────────────────────────────────────

const TAG_COMPLETIONS = [
  { label: '{% if %}',      apply: '{% if  %}\n{% endif %}',          detail: 'if / endif' },
  { label: '{% for %}',     apply: '{% for item in items %}\n{% endfor %}', detail: 'for loop' },
  { label: '{% block %}',   apply: '{% block name %}\n{% endblock %}', detail: 'block' },
  { label: '{% extends %}', apply: "{% extends '' %}",                 detail: 'inheritance' },
  { label: '{% include %}', apply: "{% include '' %}",                 detail: 'include' },
  { label: '{% set %}',     apply: '{% set var = value %}',            detail: 'set variable' },
  { label: '{% macro %}',   apply: '{% macro name(args) %}\n{% endmacro %}', detail: 'macro' },
  { label: '{% else %}',    apply: '{% else %}',                       detail: 'else' },
  { label: '{% elif %}',    apply: '{% elif  %}',                      detail: 'elif' },
  { label: '{% endif %}',   apply: '{% endif %}',                      detail: 'end if' },
  { label: '{% endfor %}',  apply: '{% endfor %}',                     detail: 'end for' },
]

const KW_COMPLETIONS = JINJA_KEYWORDS.map(k => ({ label: k, type: 'keyword' as const }))

function jinjaCompletions(ctx: CompletionContext) {
  const tagOpen = ctx.matchBefore(/\{%-?\s*\w*/)
  if (tagOpen) {
    return { from: tagOpen.from, options: TAG_COMPLETIONS.map(o => ({ ...o, type: 'function' as const })) }
  }
  const word = ctx.matchBefore(/\w+/)
  if (!word || (word.from === word.to && !ctx.explicit)) return null
  return { from: word.from, options: KW_COMPLETIONS }
}

// ── Component ──────────────────────────────────────────────────────────────────

interface JinjaEditorProps {
  value: string
  onChange: (v: string) => void
  minHeight?: string
  placeholder?: string
}

// Module-level constants — created once, never recreated on re-render
const JINJA_EXTENSIONS = [
  jinjaLanguage,
  autocompletion({ override: [jinjaCompletions], defaultKeymap: true }),
]

const BASIC_SETUP = {
  lineNumbers: true,
  foldGutter: false,
  highlightActiveLine: true,
  highlightSelectionMatches: true,
  tabSize: 2,
}

export default function JinjaEditor({ value, onChange, minHeight = '24rem', placeholder }: JinjaEditorProps) {
  const handleChange = useCallback((v: string) => onChange(v), [onChange])
  const [ready, setReady] = useState(false)
  useEffect(() => { const t = setTimeout(() => setReady(true), 50); return () => clearTimeout(t) }, [])

  if (!ready) return (
    <textarea readOnly value={value} style={{ minHeight, fontSize: '0.75rem' }}
      className="w-full font-mono border rounded px-3 py-2 bg-muted/30 resize-y" />
  )

  return (
    <CodeMirror
      value={value}
      onChange={handleChange}
      theme={oneDark}
      placeholder={placeholder}
      extensions={JINJA_EXTENSIONS}
      basicSetup={BASIC_SETUP}
      style={{ minHeight, fontSize: '0.75rem' }}
      className="border rounded overflow-hidden focus-within:ring-2 focus-within:ring-primary/50"
    />
  )
}
